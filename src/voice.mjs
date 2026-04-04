// voice.mjs — Voice input for fleet chat.
//
// Right Command: tap to toggle recording, double-tap to send.
// Transcription fills the active chat textarea — edit before sending.
// Uses Web Speech API (Chrome).
//
// Usage:
//   import { initVoice, setVoiceTarget } from './voice.mjs'
//   initVoice()
//   // When user focuses a chat input:
//   setVoiceTarget(textarea, sendTargets, agentNames)

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition

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

  _recognition.onresult = (e) => {
    // Reset watchdog — we're hearing speech
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
  _setupRecognition()
  try {
    _recognition.start()
    _watchdogTimer = setTimeout(watchdogRestart, 8000)
  } catch (err) {
    console.warn('voice: watchdog restart failed', err)
  }
}

function startRecording() {
  if (_recording || !SpeechRecognition) return

  if (!_activeTextarea) {
    showHud('no chat focused', '#c8956a')
    fadeHud(2000)
    return
  }

  // Tell other tabs to release the mic. BroadcastChannel delivery is async, so
  // delay the actual start slightly to let other tabs stop their recognition first.
  _micChannel?.postMessage('mic-start')

  _recording = true
  _audioCaptureRetries = 0
  _interimTranscript = ''
  _finalTranscript = _activeTextarea?.value || ''  // start from current textarea content

  const who = targetLabel()
  showHud(who ? `recording → ${who}` : 'recording', '#c87070')

  const doStart = () => {
    if (!_recording) return
    _setupRecognition()
    try {
      _recognition.start()
      _watchdogTimer = setTimeout(watchdogRestart, 8000)
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
  clearTimeout(_watchdogTimer)
  _watchdogTimer = null

  if (_recognition) {
    _recognition.onresult = null  // prevent late results from re-filling textarea
    _recognition.onend = null
    try { _recognition.stop() } catch {}
    _recognition = null
  }

  // Finalize: textarea already has current text from last onresult

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

export function initVoice() {
  if (_initialized) return true
  if (!SpeechRecognition) {
    console.warn('voice: Web Speech API not available (Chrome required)')
    return false
  }
  _initialized = true

  // Right Shift: tap = toggle recording, double-tap = send
  // Use capture phase so tldraw's stopPropagation doesn't block us
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'ShiftRight') return
    e.preventDefault()
    e.stopImmediatePropagation()

    const now = Date.now()
    const gap = now - _lastTapTime
    _lastTapTime = now

    // Clear pending single-tap
    clearTimeout(_singleTapTimer)

    if (gap < DOUBLE_TAP_MS) {
      // Double-tap → send
      sendCurrentText()
      _lastTapTime = 0
    } else {
      // Wait to see if it's a double-tap
      _singleTapTimer = setTimeout(() => {
        if (_recording) {
          stopRecording()
        } else {
          startRecording()
        }
      }, DOUBLE_TAP_MS)
    }
  }, true) // capture phase

  // Cross-tab: when another tab starts recording, fully stop ours
  if (_micChannel) {
    _micChannel.onmessage = (e) => {
      if (e.data === 'mic-start') stopRecording()
    }
  }

  console.log('voice: initialized v4 — BroadcastChannel:', !!_micChannel, '— Right Shift tap to toggle, double-tap to send')
  return true
}

// --- Public controls (for trackpad, pedals, etc.) ---

export function toggleRecording() {
  if (_recording) { stopRecording() } else { startRecording() }
}

export { sendCurrentText }

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
