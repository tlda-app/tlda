// voice.mjs — Voice input for fleet chat.
//
// Right Shift: tap to toggle recording.
// Transcription fills the active chat textarea — edit before sending.
// Backend: Web Speech API.
//
// Usage:
//   import { initVoice, setVoiceTarget } from './voice.mjs'
//   initVoice()
//   // When user focuses a chat input:
//   setVoiceTarget(textarea, sendTargets, agentNames)

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const _isChrome = /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent)

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
  for (const [greek, aliases] of Object.entries(GREEK)) {
    for (const alias of aliases) {
      for (const mod of MODIFIERS) {
        const cleanMod = mod === 'tilda' ? 'tilde' : mod
        patterns.push([
          new RegExp(`\\b${alias.replace(/ /g, ' ?')} ${mod}\\b`, 'gi'),
          `${greek} ${cleanMod}`
        ])
      }
    }
  }
  return patterns
}
const VOCAB_REPLACEMENTS = [
  ...buildDecoratedPatterns(),

  // Standalone Greek letter fixes
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
  [/\bfive\b/gi, 'phi'],
  [/\bfly\b/gi, 'phi'],
  [/\bfire\b/gi, 'phi'],
  [/\bfee\b/gi, 'phi'],
  [/\bfi\b/gi, 'phi'],

  // Notation modifiers
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

  // Statistical terms
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
let _filling = false
let _inputListener = null
let _fadeTimer = null
let _lastTapTime = 0
let _singleTapTimer = null
let _audioCaptureRetries = 0
let _watchdogTimer = null
let _sessionTimer = null
let _sleepDetectInterval = null
let _sleepDetectLast = 0
let _deadRestarts = 0
let _gotAudioThisSession = false

// Active chat target
let _activeTextarea = null
let _activeSendTargets = []
let _activeAgentNames = {}
let _activeAgentColor = null
let _activeSendFn = null

const DOUBLE_TAP_MS = 350

const _micChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fleet-voice-mic') : null

// --- HUD ---

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
  if (textarea !== _activeTextarea) {
    _interimTranscript = ''
    _finalTranscript = ''
    if (_inputListener && _activeTextarea) {
      _activeTextarea.removeEventListener('input', _inputListener)
      _inputListener = null
    }
    if (textarea) {
      _inputListener = () => {
        if (_filling) return
        if (!textarea.value && _finalTranscript) return  // guard: don't wipe on empty re-render
        // User edited — sync transcript and fully restart recognition
        // so Chrome has no history to replay (prevents deleted text from reappearing)
        _finalTranscript = textarea.value
        _interimTranscript = ''
        if (_recording && _recognition) {
          const dying = _recognition
          dying.onresult = null
          dying.onend = () => {
            if (_recording) {
              _setupRecognition()
              try { _recognition.start() } catch {}
            }
          }
          _recognition = null
          try { dying.stop() } catch {}
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
  if (_recording) {
    const who = targetLabel()
    showHud(who ? `recording → ${who}` : 'recording', '#c87070')
  }
}

export function clearVoiceTarget(textarea) {
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
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  _filling = false
}

// --- Speech Recognition ---

function _setupRecognition() {
  _recognition = new SpeechRecognition()
  _recognition.continuous = true
  _recognition.interimResults = true
  _recognition.lang = 'en-US'

  _recognition.onsoundstart = () => {
    _gotAudioThisSession = true
    _deadRestarts = 0
    clearTimeout(_watchdogTimer)
    _watchdogTimer = setTimeout(watchdogRestart, 8000)
  }

  _recognition.onresult = (e) => {
    _gotAudioThisSession = true
    _deadRestarts = 0
    clearTimeout(_watchdogTimer)
    _watchdogTimer = setTimeout(watchdogRestart, 8000)

    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        _finalTranscript += e.results[i][0].transcript
      } else {
        interim += e.results[i][0].transcript
      }
    }
    _interimTranscript = interim

    const combined = (_finalTranscript + interim).trim()
    if (e.results[e.results.length - 1]?.isFinal) {
      const finalTrimmed = _finalTranscript.trim()

      // Voice-switch: "left chat"/"right chat" (and Whisper variants) at end of text
      const switchMatch = finalTrimmed.match(/(right|write|great|left|next|other)\s+chat\s*[.!,]?\s*$/i)
      if (switchMatch) {
        const textareas = [...document.querySelectorAll('.fleet-chat-shape textarea')]
          .filter(ta => ta.offsetHeight > 0)
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        const target = textareas.find(ta => ta !== _activeTextarea) || textareas[0]
        if (target) {
          target.focus()
          showHud('→ other chat', '#9370db')
          fadeHud(1500)
          _finalTranscript = ''
          _interimTranscript = ''
          setTimeout(() => {
            if (_recording) {
              const w = targetLabel()
              showHud(w ? `recording → ${w}` : 'recording', '#c87070')
            }
          }, 1600)
          return
        }
      }

      // Voice-send: "send" / "send it" / "sent" at end of text
      const sendMatch = finalTrimmed.match(/(send\s*it|send|sent)\s*[.!,]?\s*$/i)
      if (sendMatch) {
        const cleanText = finalTrimmed.slice(0, sendMatch.index).trim()
        if (cleanText && _activeSendTargets.length > 0 && _activeSendFn) {
          const who = targetLabel()
          const wordCount = cleanText.split(/\s+/).length
          showHud(`sending → ${who}…`, '#c8956a')
          const result = _activeSendFn(_activeSendTargets, cleanText)
          const onSuccess = () => {
            _finalTranscript = ''
            _interimTranscript = ''
            _filling = true
            if (_activeTextarea) {
              _activeTextarea.value = ''
              _activeTextarea.style.height = 'auto'
            }
            _filling = false
            showHud(`sent ${wordCount} words → ${who}`, '#7ab8a0')
            fadeHud(2500)
            setTimeout(() => {
              if (_recording) {
                const w = targetLabel()
                showHud(w ? `recording → ${w}` : 'recording', '#c87070')
              }
            }, 2600)
          }
          const onFail = () => {
            showHud('send failed — text kept', '#c87070')
            fadeHud(3000)
            setTimeout(() => {
              if (_recording) {
                const w = targetLabel()
                showHud(w ? `recording → ${w}` : 'recording', '#c87070')
              }
            }, 3100)
          }
          if (result && typeof result.then === 'function') {
            result.then(responses => {
              if (Array.isArray(responses) && !responses.every(r => r.ok)) throw new Error()
              onSuccess()
            }).catch(onFail)
          } else {
            onSuccess() // sendFn doesn't return a promise — clear optimistically
          }
          return
        }
      }
    }

    fillTextarea(combined)
  }

  _recognition.onerror = (e) => {
    if (e.error === 'no-speech') return
    if (e.error === 'aborted') return
    console.warn('voice: speech recognition error', e.error)
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
    if (e.error === 'not-allowed') {
      showHud('requesting mic…', '#c8956a')
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
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
          showHud('mic denied — check permissions', '#c87070')
          fadeHud(5000)
        }
      }).catch(() => {
        stopRecording()
        showHud('mic denied — check permissions', '#c87070')
        fadeHud(5000)
      })
      return
    }
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
      // Preserve textarea text (including interim) before Chrome resets results
      const preservedText = _activeTextarea ? _activeTextarea.value : (_finalTranscript + _interimTranscript).trim()
      _finalTranscript = preservedText
      _interimTranscript = ''
      try { _recognition.start() } catch {}
    }
  }
}

function watchdogRestart() {
  if (!_recording) return
  if (!_gotAudioThisSession) {
    _deadRestarts++
    if (_deadRestarts >= 3) {
      showHud('voice dead — restart browser', '#c87070')
      return
    }
  }
  _gotAudioThisSession = false
  const preservedText = _activeTextarea ? _activeTextarea.value : (_finalTranscript + _interimTranscript).trim()
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
    _finalTranscript = preservedText
    _interimTranscript = ''
    _setupRecognition()
    try {
      _recognition.start()
      _watchdogTimer = setTimeout(watchdogRestart, 8000)
      _sessionTimer = setTimeout(sessionRestart, 45000)
    } catch (err) {
      console.warn('voice: watchdog restart failed', err)
      _watchdogTimer = setTimeout(watchdogRestart, 8000)
      _sessionTimer = setTimeout(sessionRestart, 45000)
    }
  }, 250)
}

function sessionRestart() {
  if (!_isChrome) return
  if (!_recording) return
  if (!_recognition) return
  const preservedText = _activeTextarea ? _activeTextarea.value : (_finalTranscript + _interimTranscript).trim()
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
    _finalTranscript = preservedText
    _interimTranscript = ''
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

function checkSleep() {
  if (!_recording) return
  if (!_recognition) return
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

// --- Recording ---

function startRecording() {
  if (_recording) return
  if (!SpeechRecognition) return

  if (!_activeTextarea) {
    showHud('no chat focused', '#c8956a')
    fadeHud(2000)
    return
  }

  _micChannel?.postMessage('mic-start')

  _recording = true
  _interimTranscript = ''
  _finalTranscript = _activeTextarea?.value || ''

  const who = targetLabel()
  showHud(who ? `recording → ${who}` : 'recording', '#c87070')

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
    setTimeout(doStart, 300)
  } else {
    doStart()
  }
}

function stopRecording() {
  if (!_recording) return
  _recording = false

  clearTimeout(_watchdogTimer)
  _watchdogTimer = null
  clearTimeout(_sessionTimer)
  _sessionTimer = null
  clearInterval(_sleepDetectInterval)
  _sleepDetectInterval = null

  if (_recognition) {
    _recognition.onresult = null
    _recognition.onend = null
    try { _recognition.stop() } catch {}
    _recognition = null
  }

  const who = targetLabel()
  showHud(who ? `paused → ${who}` : 'paused', '#9370db')
  fadeHud(4000)
}

function sendCurrentText() {
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

  const who = targetLabel()
  showHud(`sending → ${who}…`, '#c8956a')

  const result = _activeSendFn ? _activeSendFn(_activeSendTargets, text) : null
  const onSuccess = () => {
    showHud(`sent → ${who}`, '#7ab8a0')
    fadeHud(2500)
    ta.value = ''
    ta.style.height = 'auto'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    _interimTranscript = ''
    _finalTranscript = ''
  }
  const onFail = () => {
    showHud('send failed — text kept', '#c87070')
    fadeHud(3000)
  }
  if (result && typeof result.then === 'function') {
    result.then(responses => {
      if (Array.isArray(responses) && !responses.every(r => r.ok)) throw new Error()
      onSuccess()
    }).catch(onFail)
  } else {
    onSuccess()
  }
}

// --- Key Binding ---

let _initialized = false

export async function initVoice() {
  if (_initialized) return true
  _initialized = true

  if (!SpeechRecognition) {
    console.warn('voice: Web Speech API not available')
    return false
  }

  // Right Shift: tap = toggle recording. Enter sends (handled by FleetChatShape).
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'ShiftRight') return
    e.preventDefault()
    e.stopImmediatePropagation()

    if (_recording) {
      stopRecording()
    } else {
      startRecording()
    }
  }, true)

  if (_micChannel) {
    _micChannel.onmessage = (e) => {
      if (e.data === 'mic-start') stopRecording()
    }
  }

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

  console.log(`voice: initialized v6 — Web Speech API — BroadcastChannel: ${!!_micChannel}`)
  return true
}

// --- Public controls ---

export function toggleRecording() {
  if (_recording) { stopRecording() } else { startRecording() }
}

export function restartRecording() {
  if (!_recording) return
  stopRecording()
  startRecording()
}

export { sendCurrentText, stopRecording }

// --- State queries ---

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
  // Don't touch recognition here — callers use restartRecording() for that.
  // Doing both creates duplicate recognition instances (onend callback races
  // with startRecording, spawning two competing sessions).
}
