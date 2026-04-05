// voice.mjs — Voice input for fleet chat.
//
// Right Shift: tap to toggle recording, double-tap to send.
// Transcription fills the active chat textarea — edit before sending.
// Backend: local whisper.cpp server (preferred) or Web Speech API (fallback).
//
// Usage:
//   import { initVoice, setVoiceTarget } from './voice.mjs'
//   initVoice()
//   // When user focuses a chat input:
//   setVoiceTarget(textarea, sendTargets, agentNames)

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const _isChrome = /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent)

// --- Whisper backend state ---
const WHISPER_URL = 'http://127.0.0.1:8178'
let _useWhisper = false        // set true at init if whisper server is reachable
let _micStream = null          // MediaStream from getUserMedia
let _mediaRecorder = null      // MediaRecorder instance
let _audioChunks = []          // accumulated audio data chunks
let _whisperAbort = null       // AbortController — cancel in-flight transcription on reset/stop
let _whisperLoopRunning = false // true while the sequential transcription loop is active
let _whisperLoopGen = 0          // incremented on each startWhisperRecording — stale loops exit

// Math mode — when on, aggressive replacements for Greek letters
// (replaces common English words that sound like Greek letters)
let _mathMode = false

// --- Math/stats vocabulary post-processing ---
// Web Speech API frequently misrecognizes domain-specific terms.
// This map fixes common substitutions after transcription.

// Greek letters and their known Chrome misrecognitions
const GREEK = {
  phi:   ['five', 'fly', 'fire', 'fee', 'fi', 'phi'],
  theta: ['fat a', 'the a', 'theta a', 'theta', 'data'],
  gamma: ['gama', 'gamma'],
  psi:   ['sigh', 'psi'],
  tau:   ['tao', 'tau'],
  eta:   ['aida', 'eta'],
  chi:   ['chee', 'chi'],
  xi:    ['zie', 'ksee', 'xi'],
  zeta:  ['zeeta', 'zeta'],
  mu:    ['mew', 'mu'],
  nu:    ['knew', 'nu'],
  rho:   ['rho'],
  sigma: ['sigma'],
}
const MODIFIERS = ['hat', 'tilda', 'tilde', 'star', 'bar', 'check', 'dot']

function buildDecoratedPatterns() {
  const patterns = []
  // "letter modifier" → "letter modifier" (with corrected spelling)
  for (const [greek, aliases] of Object.entries(GREEK)) {
    for (const alias of aliases) {
      for (const mod of MODIFIERS) {
        // e.g. "five hat" → "phi hat", "fat a tilda" → "theta tilde"
        const cleanMod = mod === 'tilda' ? 'tilde' : mod
        patterns.push([
          new RegExp(`\\b${alias.replace(/ /g, ' ?')} ${mod}\\b`, 'gi'),
          `${greek} ${cleanMod}`
        ])
      }
    }
  }
  // Orphaned modifiers are handled in MATH_MODE_REPLACEMENTS (too aggressive for normal mode)
  return patterns
}
const VOCAB_REPLACEMENTS = [
  // Decorated Greek letters — "phi hat", "theta tilde", etc. as compound words.
  // Also rescues orphaned modifiers (Chrome eats the letter, leaves just "hat").
  // Chrome's language model eats the letter and leaves just the modifier,
  // so we also catch orphaned modifiers (hat/tilde/star) and assume phi.
  // Order matters: compound patterns first, then orphan rescue.
  ...buildDecoratedPatterns(),

  // Standalone Greek letter fixes (non-compound, safe replacements only)
  [/\bfat a\b/gi, 'theta'],
  [/\bthe a\b/gi, 'theta'],
  [/\btheta a\b/gi, 'theta'],
  [/\bgama\b/gi, 'gamma'],
  [/\btao\b/gi, 'tau'],
  [/\baida\b/gi, 'eta'],
  [/\bchee\b/gi, 'chi'],
  [/\bzie\b/gi, 'xi'],
  [/\bksee\b/gi, 'xi'],
  [/\bzeeta\b/gi, 'zeta'],
  [/\bmew\b/gi, 'mu'],
  // Phi — aggressive because it's the key parameter
  [/\bfive\b/gi, 'phi'],
  [/\bfly\b/gi, 'phi'],
  [/\bfire\b/gi, 'phi'],
  [/\bfee\b/gi, 'phi'],
  [/\bfi\b/gi, 'phi'],

  // Notation modifiers (standalone cleanup)
  [/\btilda\b/gi, 'tilde'],
  [/\bsuper ?script star\b/gi, '*'],

  // Named methods / frameworks
  [/\bbreck ?man\b/gi, 'Bregman'],
  [/\bbreg ?man\b/gi, 'Bregman'],
  [/\bberkman\b/gi, 'Bregman'],
  [/\breese\b/gi, 'Riesz'],
  [/\breeze\b/gi, 'Riesz'],
  [/\brees\b/gi, 'Riesz'],
  [/\bar ?k ?h ?s\b/gi, 'RKHS'],
  [/\bmatern\b/gi, 'Matérn'],
  [/\bsobo ?lev\b/gi, 'Sobolev'],

  // Statistical terms — only misrecognitions, not real words
  [/\bsemi ?norm\b/gi, 'seminorm'],
  [/\basymptomatic\b/gi, 'asymptotic'],
  [/\bestimand\b/gi, 'estimand'],
  [/\bestimands\b/gi, 'estimands'],
  [/\bnewsonce\b/gi, 'nuisance'],
  [/\bnewsance\b/gi, 'nuisance'],
  [/\bhilbert\b/gi, 'Hilbert'],

  // Paper-specific compound terms
  [/\bcross[ -]?fitting\b/gi, 'cross-fitting'],
  [/\bdouble[ -]?robust\b/gi, 'doubly robust'],
  [/\bkernel[ -]?ridge\b/gi, 'kernel ridge'],
  [/\bkernel[ -]?balance\b/gi, 'kernel balancing'],
  [/\bkernel[ -]?balancing\b/gi, 'kernel balancing'],
  [/\bsynthetic[ -]?control\b/gi, 'synthetic control'],
]

// Math-mode-only replacements — too aggressive for normal speech
const MATH_MODE_REPLACEMENTS = (() => {
  const pats = []
  // Orphaned modifiers — Chrome ate the letter. Default to phi.
  const greekNames = Object.keys(GREEK).join('|')
  for (const mod of MODIFIERS) {
    const cleanMod = mod === 'tilda' ? 'tilde' : mod
    pats.push([
      new RegExp(`(?<!(?:${greekNames}) )\\b${mod}\\b`, 'gi'),
      `phi ${cleanMod}`
    ])
  }
  return pats
})()

function postProcessTranscript(text) {
  let result = text
  for (const [pattern, replacement] of VOCAB_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  if (_mathMode) {
    for (const [pattern, replacement] of MATH_MODE_REPLACEMENTS) {
      result = result.replace(pattern, replacement)
    }
  }
  return result
}

let _hud = null
let _recognition = null
let _recording = false
let _interimTranscript = ''
let _finalTranscript = ''
let _filling = false         // true while fillTextarea is writing — suppresses manual-edit detection
let _inputListener = null    // cleanup ref for manual-edit listener
let _fadeTimer = null
let _lastTapTime = 0
let _singleTapTimer = null
let _audioCaptureRetries = 0
let _watchdogTimer = null
let _sessionTimer = null       // proactive 45s restart — prevents Chrome's ~60s silent death
let _sleepDetectInterval = null // setInterval-based drift detector for sleep/wake
let _sleepDetectLast = 0       // Date.now() at last interval tick
let _deadRestarts = 0          // consecutive restarts with no audio — detects poisoned state
let _gotAudioThisSession = false // reset on each restart, set true on onsoundstart/onresult

// Active chat target — set by the chat component on focus
let _activeTextarea = null   // HTMLTextAreaElement
let _activeSendTargets = []  // string[] of agent IDs
let _activeAgentNames = {}   // { [id]: name }
let _activeAgentColor = null // hex color of primary send target
let _activeSendFn = null     // optional (targets, text) => void

const DOUBLE_TAP_MS = 350

// Cross-tab mic coordination: when a tab starts recording it broadcasts 'mic-start'
// so other tabs release the mic. Each tab keeps _recording=true (resumes on focus).
const _micChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fleet-voice-mic') : null

// --- HUD (minimal — just recording indicator) ---

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function ensureHud() {
  if (_hud) return _hud
  _hud = document.createElement('div')
  _hud.id = 'voice-hud'
  Object.assign(_hud.style, {
    position: 'fixed',
    bottom: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    borderRadius: '4px',
    padding: '3px 10px',
    zIndex: '99999',
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    fontSize: '10px',
    letterSpacing: '0.02em',
    background: 'rgba(255,255,255,0.08)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255,255,255,0.12)',
    display: 'none',
    transition: 'opacity 0.2s',
    opacity: '0',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  })
  document.body.appendChild(_hud)
  return _hud
}

function showHud(text, stateColor) {
  const hud = ensureHud()
  clearTimeout(_fadeTimer)
  hud.textContent = text
  // Use agent color (or state color) as text color
  hud.style.color = _activeAgentColor || stateColor || 'rgba(255,255,255,0.7)'
  hud.style.display = 'block'
  requestAnimationFrame(() => { hud.style.opacity = '1' })
}

function hideHud() {
  clearTimeout(_fadeTimer)
  if (_hud) {
    _hud.style.opacity = '0'
    setTimeout(() => { if (_hud) _hud.style.display = 'none' }, 300)
  }
}

function fadeHud(delayMs = 2000) {
  _fadeTimer = setTimeout(hideHud, delayMs)
}

// --- Target Management ---

export function setVoiceTarget(textarea, sendTargets, agentNames, sendFn, agentColor) {
  // Reset transcript state when switching targets to avoid carrying over old text
  if (textarea !== _activeTextarea) {
    _interimTranscript = ''
    _finalTranscript = ''
    // Clear accumulated audio so whisper doesn't transcribe old-chat audio into new target
    if (_useWhisper) {
      if (_whisperAbort) { _whisperAbort.abort(); _whisperAbort = null }
      _audioChunks = []
    }
    // Clean up old listener
    if (_inputListener && _activeTextarea) {
      _activeTextarea.removeEventListener('input', _inputListener)
      _inputListener = null
    }
    // Listen for manual edits on the new textarea — sync _finalTranscript
    // so deleted text doesn't reappear on next voice result
    if (textarea) {
      _inputListener = () => {
        if (_filling) return  // ignore our own programmatic fills
        // Sync _finalTranscript to whatever the user left in the textarea,
        // then restart recognition to clear its accumulated results array.
        _finalTranscript = textarea.value
        _interimTranscript = ''
        if (_recording && _recognition) {
          try { _recognition.stop() } catch {}
          // onend handler will restart it
        }
      }
      textarea.addEventListener('input', _inputListener)
    }
  }
  _activeTextarea = textarea
  _activeSendTargets = sendTargets || []
  _activeAgentNames = agentNames || {}
  _activeAgentColor = agentColor || null
  _activeSendFn = sendFn || null
  // Update HUD if recording so indicator reflects new target
  if (_recording) {
    const who = targetLabel()
    showHud(who ? `recording → ${who}` : 'recording', '#c87070')
  }
}

export function clearVoiceTarget(textarea) {
  // Only clear if it's the same textarea (avoid race with another chat focusing)
  if (_activeTextarea === textarea) {
    _activeTextarea = null
    _activeSendTargets = []
    _activeAgentNames = {}
    _activeSendFn = null
  }
}

function targetLabel() {
  if (_activeSendTargets.length === 0) return null
  return _activeSendTargets
    .map(id => _activeAgentNames[id] || id.replace('fleet:', ''))
    .join(', ')
}

// --- Fill textarea with transcription ---

function fillTextarea(text) {
  const ta = _activeTextarea
  if (!ta) return
  _filling = true
  ta.value = postProcessTranscript(text)
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  // Fire input event so React/highlight underlay picks up the change
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  _filling = false
}

// --- Speech Recognition ---

// Create a fresh SpeechRecognition instance and assign to _recognition.
// Using a new instance (rather than calling .start() on an existing one) ensures
// Chrome's accumulated session state and any buffered results from the previous
// session can't bleed into the new one.
function _setupRecognition() {
  _recognition = new SpeechRecognition()
  _recognition.continuous = true
  _recognition.interimResults = true
  _recognition.lang = 'en-US'

  _recognition.onsoundstart = () => {
    // Any audio activity resets the watchdog — connection is alive
    _gotAudioThisSession = true
    _deadRestarts = 0
    clearTimeout(_watchdogTimer)
    _watchdogTimer = setTimeout(watchdogRestart, 8000)
  }

  _recognition.onresult = (e) => {
    // Reset watchdog — we're hearing speech
    _gotAudioThisSession = true
    _deadRestarts = 0
    clearTimeout(_watchdogTimer)
    _watchdogTimer = setTimeout(watchdogRestart, 8000)

    // Only process results from resultIndex onward (new/changed results).
    // Finalized results accumulate in _finalTranscript so we don't replay
    // old text that the user may have deleted from the textarea.
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        _finalTranscript += e.results[i][0].transcript
      } else {
        interim += e.results[i][0].transcript
      }
    }
    _interimTranscript = interim
    fillTextarea((_finalTranscript + interim).trim())
  }

  _recognition.onerror = (e) => {
    if (e.error === 'no-speech') return
    if (e.error === 'aborted') return  // normal during restart
    console.warn('voice: speech recognition error', e.error)
    // audio-capture = mic held by another tab/process. Auto-retry with backoff.
    if (e.error === 'audio-capture') {
      if (_audioCaptureRetries < 3) {
        _audioCaptureRetries++
        const retryDelay = 500 * Math.pow(2, _audioCaptureRetries - 1)
        showHud(`mic busy — retrying (${_audioCaptureRetries}/3)…`, '#c8956a')
        setTimeout(() => {
          if (!_recording) return
          _setupRecognition()
          try {
            _recognition.start()
            _watchdogTimer = setTimeout(watchdogRestart, 8000)
          } catch (err) {
            console.warn('voice: audio-capture retry failed', err)
            stopRecording()
            showHud('mic failed — reload tab', '#c87070')
            fadeHud(5000)
          }
        }, retryDelay)
      } else {
        stopRecording()
        showHud('mic failed — reload tab', '#c87070')
        fadeHud(5000)
      }
      return
    }
    // not-allowed = mic permission denied or needs user gesture (common in Safari).
    // Request mic via getUserMedia to trigger the permission prompt, then retry.
    if (e.error === 'not-allowed') {
      showHud('requesting mic…', '#c8956a')
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        // Got permission — stop the stream (SpeechRecognition manages its own) and retry
        stream.getTracks().forEach(t => t.stop())
        if (!_recording) return
        _setupRecognition()
        try {
          _recognition.start()
          _watchdogTimer = setTimeout(watchdogRestart, 8000)
          const who = targetLabel()
          showHud(who ? `recording → ${who}` : 'recording', '#c87070')
        } catch (err) {
          console.warn('voice: not-allowed retry failed', err)
          stopRecording()
          showHud('mic denied — check Safari permissions', '#c87070')
          fadeHud(5000)
        }
      }).catch(() => {
        stopRecording()
        showHud('mic denied — check Safari permissions', '#c87070')
        fadeHud(5000)
      })
      return
    }
    // Retry network errors only
    if (_recording && e.error === 'network') {
      showHud('mic error — retrying…', '#c8956a')
      setTimeout(() => {
        if (!_recording) return
        _setupRecognition()
        try {
          _recognition.start()
          const who = targetLabel()
          showHud(who ? `recording → ${who}` : 'recording', '#c87070')
        } catch (err) {
          console.warn('voice: retry failed', err)
          showHud('mic failed — tap to restart', '#c87070')
          fadeHud(5000)
          _recording = false
        }
      }, 1000)
      return
    }
    showHud('mic error: ' + e.error, '#c87070')
    fadeHud(3000)
    _recording = false
  }

  _recognition.onend = () => {
    if (_recording) {
      try { _recognition.start() } catch {}
    }
  }
}

function watchdogRestart() {
  if (!_recording) return
  // Track consecutive dead restarts (no audio received since last restart)
  if (!_gotAudioThisSession) {
    _deadRestarts++
    if (_deadRestarts >= 3) {
      showHud('voice dead — restart Chrome', '#c87070')
      // Don't fade — keep visible until user acts
      return  // stop retrying, it's poisoned
    }
  }
  _gotAudioThisSession = false
  // The old connection is hung — abort() rather than stop(), which can also hang.
  const dying = _recognition
  if (dying) {
    dying.onresult = null
    dying.onend = null
    dying.onsoundstart = null
    try { dying.abort() } catch {}
  }
  _recognition = null
  clearTimeout(_watchdogTimer)
  _watchdogTimer = null
  // Cancel the session timer — it will be rescheduled after the restart.
  clearTimeout(_sessionTimer)
  _sessionTimer = null
  // Brief delay to let Chrome fully release the mic before claiming it again.
  setTimeout(() => {
    if (!_recording) return
    _setupRecognition()
    try {
      _recognition.start()
      _watchdogTimer = setTimeout(watchdogRestart, 8000)
      _sessionTimer = setTimeout(sessionRestart, 45000)
    } catch (err) {
      console.warn('voice: watchdog restart failed', err)
      _watchdogTimer = setTimeout(watchdogRestart, 8000)  // always reschedule
      _sessionTimer = setTimeout(sessionRestart, 45000)
    }
  }, 250)
}

// Proactive 45s session restart — fires before Chrome's ~60s silent-death timeout.
// Chrome-only: Safari uses a different backend that doesn't have this bug.
function sessionRestart() {
  if (!_isChrome) return
  if (!_recording) return
  if (!_recognition) return  // another restart already in progress
  const dying = _recognition
  if (dying) {
    dying.onresult = null
    dying.onend = null
    dying.onsoundstart = null
    try { dying.abort() } catch {}
  }
  _recognition = null
  clearTimeout(_watchdogTimer)
  _watchdogTimer = null
  clearTimeout(_sessionTimer)
  _sessionTimer = null
  setTimeout(() => {
    if (!_recording) return
    _setupRecognition()
    try {
      _recognition.start()
      _watchdogTimer = setTimeout(watchdogRestart, 8000)
      _sessionTimer = setTimeout(sessionRestart, 45000)
    } catch (err) {
      console.warn('voice: session restart failed', err)
      _sessionTimer = setTimeout(sessionRestart, 45000)
    }
  }, 250)
}

// Sleep/wake detection via setInterval drift.
// If the gap between ticks exceeds 10s the machine likely slept — force a restart.
function checkSleep() {
  if (!_recording) return
  if (!_recognition) return  // another restart already in progress
  const now = Date.now()
  const gap = now - _sleepDetectLast
  _sleepDetectLast = now
  if (gap > 10000) {
    clearTimeout(_sessionTimer)
    _sessionTimer = null
    const dying = _recognition
    if (dying) {
      dying.onresult = null
      dying.onend = null
      dying.onsoundstart = null
      try { dying.abort() } catch {}
    }
    _recognition = null
    clearTimeout(_watchdogTimer)
    _watchdogTimer = null
    setTimeout(() => {
      if (!_recording) return
      _sleepDetectLast = Date.now()
      _setupRecognition()
      try {
        _recognition.start()
        _watchdogTimer = setTimeout(watchdogRestart, 8000)
        _sessionTimer = setTimeout(sessionRestart, 45000)
      } catch (err) {
        console.warn('voice: sleep-wake restart failed', err)
        _sessionTimer = setTimeout(sessionRestart, 45000)
      }
    }, 250)
  }
}

// --- Whisper backend ---

async function whisperTranscribe(blob, signal) {
  const form = new FormData()
  form.append('file', blob, 'audio.webm')
  form.append('response_format', 'json')
  const res = await fetch(`${WHISPER_URL}/inference`, { method: 'POST', body: form, signal })
  if (!res.ok) throw new Error(`whisper: ${res.status}`)
  const data = await res.json()
  return (data.text || '')
    .replace(/\[BLANK_AUDIO\]/gi, '')
    .replace(/\[silence\]/gi, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Sequential transcription loop — at most one request in-flight at a time.
// Sends ALL accumulated audio each cycle so whisper has full context.
// resetTranscript() aborts the in-flight request via _whisperAbort, so
// there are no stale results to race with.
async function whisperLoop(mimeType, gen) {
  _whisperLoopRunning = true
  while (_recording && gen === _whisperLoopGen) {
    // Wait 3s between transcriptions
    await new Promise(r => setTimeout(r, 3000))
    if (!_recording || gen !== _whisperLoopGen || _audioChunks.length === 0) continue
    const ac = new AbortController()
    _whisperAbort = ac
    try {
      const blob = new Blob(_audioChunks, { type: mimeType })
      const text = await whisperTranscribe(blob, ac.signal)
      if (_recording && gen === _whisperLoopGen && text && !ac.signal.aborted) {
        fillTextarea(text)
      }
    } catch (err) {
      if (err.name === 'AbortError') continue
      console.warn('voice: whisper transcription error', err)
    } finally {
      if (_whisperAbort === ac) _whisperAbort = null
    }
  }
  _whisperLoopRunning = false
}

function startWhisperRecording() {
  const gen = ++_whisperLoopGen  // invalidate any stale loop
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    if (!_recording || gen !== _whisperLoopGen) { stream.getTracks().forEach(t => t.stop()); return }
    _micStream = stream
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm'
    _mediaRecorder = new MediaRecorder(stream, { mimeType })
    _audioChunks = []

    _mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) _audioChunks.push(e.data)
    }

    _mediaRecorder.start(1000) // ondataavailable every 1s
    whisperLoop(mimeType, gen)
  }).catch(err => {
    console.warn('voice: mic access failed', err)
    _recording = false
    showHud('mic denied', '#c87070')
    fadeHud(3000)
  })
}

function stopWhisperCleanup() {
  if (_whisperAbort) { _whisperAbort.abort(); _whisperAbort = null }
  _audioChunks = []
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    _mediaRecorder.ondataavailable = null
    try { _mediaRecorder.stop() } catch {}
  }
  _mediaRecorder = null
  if (_micStream) {
    _micStream.getTracks().forEach(t => t.stop())
    _micStream = null
  }
}

function startRecording() {
  if (_recording) return
  if (!_useWhisper && !SpeechRecognition) return

  if (!_activeTextarea) {
    showHud('no chat focused', '#c8956a')
    fadeHud(2000)
    return
  }

  // Tell other tabs to release the mic. BroadcastChannel delivery is async, so
  // delay the actual start slightly to let other tabs stop their recognition first.
  _micChannel?.postMessage('mic-start')

  _recording = true
  _interimTranscript = ''
  _finalTranscript = _activeTextarea?.value || ''  // start from current textarea content

  const who = targetLabel()
  showHud(who ? `recording → ${who}` : 'recording', '#c87070')

  if (_useWhisper) {
    startWhisperRecording()
    return
  }

  // Web Speech API path
  _audioCaptureRetries = 0
  _deadRestarts = 0
  _gotAudioThisSession = false

  const doStart = () => {
    if (!_recording) return
    _setupRecognition()
    try {
      _recognition.start()
      _watchdogTimer = setTimeout(watchdogRestart, 8000)
      _sessionTimer = setTimeout(sessionRestart, 45000)
      _sleepDetectLast = Date.now()
      _sleepDetectInterval = setInterval(checkSleep, 2000)
    } catch (err) {
      console.warn('voice: could not start recognition', err)
      _recording = false
      showHud('mic failed — tap to retry', '#c87070')
      fadeHud(3000)
    }
  }

  if (_micChannel) {
    setTimeout(doStart, 300)  // give other tabs time to process mic-start
  } else {
    doStart()
  }
}

function stopRecording() {
  if (!_recording) return
  _recording = false

  if (_useWhisper) {
    stopWhisperCleanup()
    const who = targetLabel()
    showHud(who ? `paused → ${who}` : 'paused', '#9370db')
    fadeHud(4000)
    return
  }

  // Web Speech API cleanup
  clearTimeout(_watchdogTimer)
  _watchdogTimer = null
  clearTimeout(_sessionTimer)
  _sessionTimer = null
  clearInterval(_sleepDetectInterval)
  _sleepDetectInterval = null

  if (_recognition) {
    _recognition.onresult = null  // prevent late results from re-filling textarea
    _recognition.onend = null
    try { _recognition.stop() } catch {}
    _recognition = null
  }

  const who = targetLabel()
  showHud(who ? `paused → ${who}` : 'paused', '#9370db')
  fadeHud(4000)
}

function sendCurrentText() {
  // Stop recording if active
  if (_recording) stopRecording()

  const ta = _activeTextarea
  if (!ta) {
    showHud('no chat focused', '#c8956a')
    fadeHud(2000)
    return
  }

  const text = ta.value.trim()
  if (!text) {
    showHud('nothing to send', '#6b6b88')
    fadeHud(1500)
    return
  }

  if (_activeSendTargets.length === 0) {
    showHud('no send target', '#c8956a')
    fadeHud(2000)
    return
  }

  if (_activeSendFn) {
    _activeSendFn(_activeSendTargets, text)
  }

  const who = targetLabel()
  showHud(`sent → ${who}`, '#7ab8a0')
  fadeHud(2500)

  // Clear textarea
  ta.value = ''
  ta.style.height = 'auto'
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  _interimTranscript = ''
  _finalTranscript = ''
}

// --- Key Binding ---

let _initialized = false

export async function initVoice() {
  if (_initialized) return true
  _initialized = true

  // Detect whisper server
  try {
    const res = await fetch(`${WHISPER_URL}/`, { method: 'GET', signal: AbortSignal.timeout(1000) })
    if (res.ok) {
      _useWhisper = true
      console.log('voice: whisper server detected at', WHISPER_URL)
    }
  } catch {
    // whisper not available — fall back to Web Speech API
  }

  if (!_useWhisper && !SpeechRecognition) {
    console.warn('voice: no backend available (no whisper server, no Web Speech API)')
    return false
  }

  // Right Shift: tap = toggle recording. Enter sends (handled by FleetChatShape).
  // Use capture phase so tldraw's stopPropagation doesn't block us
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'ShiftRight') return
    e.preventDefault()
    e.stopImmediatePropagation()

    // Simple toggle — no double-tap detection, no send
    if (_recording) {
      stopRecording()
    } else {
      startRecording()
    }
  }, true) // capture phase

  // Cross-tab: when another tab starts recording, fully stop ours
  if (_micChannel) {
    _micChannel.onmessage = (e) => {
      if (e.data === 'mic-start') stopRecording()
    }
  }

  // Tab visibility: returning to a hidden tab can silently kill the speech connection.
  // Abort the potentially-dead instance and restart when tab becomes visible again.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _recording) {
      const dying = _recognition
      if (dying) {
        dying.onresult = null
        dying.onend = null
        dying.onsoundstart = null
        try { dying.abort() } catch {}
      }
      _recognition = null
      clearTimeout(_watchdogTimer)
      _watchdogTimer = null
      setTimeout(() => {
        if (!_recording) return
        _setupRecognition()
        try {
          _recognition.start()
          _watchdogTimer = setTimeout(watchdogRestart, 8000)
        } catch (err) {
          console.warn('voice: visibilitychange restart failed', err)
          _watchdogTimer = setTimeout(watchdogRestart, 8000)
        }
      }, 250)
    }
  })

  const backend = _useWhisper ? 'whisper' : 'Web Speech API'
  console.log(`voice: initialized v5 — ${backend} — BroadcastChannel: ${!!_micChannel} — Right Shift tap to toggle, double-tap to send`)
  return true
}

// --- Public controls (for trackpad, pedals, etc.) ---

export function toggleRecording() {
  if (_recording) { stopRecording() } else { startRecording() }
}

// Stop → clear → start. Used by Enter-send so the user can keep talking
// without pressing Right Shift again. No-ops if not recording.
export function restartRecording() {
  if (!_recording) return
  stopRecording()
  startRecording()
}

export { sendCurrentText, stopRecording }

// --- State queries for external UI ---

export function isRecording() { return _recording }
export function getTranscript() { return _activeTextarea ? _activeTextarea.value : '' }
export function addVocabReplacement(pattern, replacement) {
  VOCAB_REPLACEMENTS.push([pattern, replacement])
}
export function setMathMode(on) {
  _mathMode = on
  if (_recording) {
    const who = targetLabel()
    const mode = on ? ' [math]' : ''
    showHud(who ? `recording → ${who}${mode}` : `recording${mode}`, '#c87070')
  }
}
export function isMathMode() { return _mathMode }
export function resetTranscript() {
  _interimTranscript = ''
  _finalTranscript = ''
  if (_useWhisper) {
    // Abort any in-flight whisper request — sequential loop will skip the result
    if (_whisperAbort) { _whisperAbort.abort(); _whisperAbort = null }
    _audioChunks = []
  }
  if (_recording && _recognition) {
    // Null handlers on the old instance before stopping — prevents any buffered
    // results from the old session reaching the new one.
    const dying = _recognition
    dying.onresult = null
    dying.onend = () => {
      // Old session fully dead — spawn a completely fresh instance so Chrome
      // has no accumulated context or buffered results to bleed through.
      if (_recording) {
        _setupRecognition()
        try { _recognition.start() } catch {}
      }
    }
    _recognition = null
    try { dying.stop() } catch {}
  }
}

// Debug/test API
if (typeof window !== 'undefined') {
  window._voiceDebug = () => ({
    recording: _recording,
    useWhisper: _useWhisper,
    audioChunks: _audioChunks.length,
    hasMediaRecorder: !!_mediaRecorder,
    recorderState: _mediaRecorder?.state || 'none',
    hasMicStream: !!_micStream,
    whisperInFlight: !!_whisperAbort,
    whisperLoopRunning: _whisperLoopRunning,
    textarea: _activeTextarea?.value || '',
  })
  // Expose functions for integration testing
  window._voiceTest = {
    setTarget: (ta, targets, names, sendFn) => setVoiceTarget(ta, targets, names, sendFn),
    toggle: () => toggleRecording(),
    reset: () => resetTranscript(),
    isRecording: () => _recording,
    pushChunk: (data) => { _audioChunks.push(data || new Blob(['fake'], { type: 'audio/webm' })) },
    clearChunks: () => { _audioChunks = [] },
    getChunkCount: () => _audioChunks.length,
  }
}
