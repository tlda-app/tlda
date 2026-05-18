// voice.mjs — Voice input for fleet chat.
//
// Right Shift: tap to toggle recording, double-tap to send.
// Transcription via local whisper.cpp (POST to /inference).
// Fills the active chat textarea — edit before sending.
//
// Usage:
//   import { initVoice, setVoiceTarget } from './voice.mjs'
//   initVoice()
//   // When user focuses a chat input:
//   setVoiceTarget(textarea, sendTargets, agentNames)

const WHISPER_URL = 'http://127.0.0.1:8178/inference'

// Math mode — when on, aggressive replacements for Greek letters
let _mathMode = false

// --- Math/stats vocabulary post-processing ---
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

// --- State ---

let _hud = null
let _recording = false
let _filling = false
let _inputListener = null
let _fadeTimer = null
let _lastTapTime = 0
let _singleTapTimer = null

// MediaRecorder state
let _mediaStream = null
let _recorder = null
let _chunks = []

// Generation counter: incremented on each reset/send cycle.
// Whisper responses tagged with a stale generation are discarded.
let _generation = 0

// Active chat target
let _activeTextarea = null
let _activeSendTargets = []
let _activeAgentNames = {}
let _activeAgentColor = null
let _activeSendFn = null

const DOUBLE_TAP_MS = 350

// Cross-tab mic coordination
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
    if (_inputListener && _activeTextarea) {
      _activeTextarea.removeEventListener('input', _inputListener)
      _inputListener = null
    }
    if (textarea) {
      _inputListener = () => {
        if (_filling) return
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

// --- Fill textarea ---

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

// --- Whisper transcription ---

// Send audio blob to whisper.cpp and append result to textarea.
// Tagged with generation — stale responses are silently discarded.
function transcribe(blob, gen) {
  const form = new FormData()
  form.append('file', blob, 'recording.wav')
  form.append('response_format', 'json')

  fetch(WHISPER_URL, { method: 'POST', body: form })
    .then(r => {
      if (!r.ok) throw new Error(`whisper ${r.status}`)
      return r.json()
    })
    .then(data => {
      // Discard if generation has moved on (user hit Enter / reset)
      if (gen !== _generation) return

      const text = (data.text || '').trim()
      if (!text) return

      const ta = _activeTextarea
      if (!ta) return

      // Append to whatever is currently in the textarea
      const current = ta.value
      const separator = current && !current.endsWith(' ') ? ' ' : ''
      fillTextarea(current + separator + text)
    })
    .catch(err => {
      if (gen !== _generation) return
      console.warn('voice: whisper transcription failed', err)
      showHud('whisper error', '#c8956a')
      fadeHud(3000)
    })
}

// --- MediaRecorder lifecycle ---

async function acquireStream() {
  if (_mediaStream) return _mediaStream
  _mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
    }
  })
  return _mediaStream
}

function releaseStream() {
  if (_mediaStream) {
    for (const track of _mediaStream.getTracks()) track.stop()
    _mediaStream = null
  }
}

async function startRecording() {
  if (_recording) return

  if (!_activeTextarea) {
    showHud('no chat focused', '#c8956a')
    fadeHud(2000)
    return
  }

  // Tell other tabs to release the mic
  _micChannel?.postMessage('mic-start')

  _recording = true
  const who = targetLabel()
  showHud(who ? `recording → ${who}` : 'recording', '#c87070')

  const doStart = async () => {
    if (!_recording) return
    try {
      const stream = await acquireStream()

      // Pick a supported mime type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''

      _recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      _chunks = []

      _recorder.ondataavailable = (e) => {
        if (e.data.size > 0) _chunks.push(e.data)
      }

      _recorder.onstop = () => {
        if (_chunks.length === 0) return
        const blob = new Blob(_chunks, { type: _recorder?.mimeType || 'audio/webm' })
        _chunks = []
        // Fire transcription — don't block recording
        transcribe(blob, _generation)
      }

      _recorder.start()
    } catch (err) {
      console.warn('voice: could not start recording', err)
      _recording = false
      showHud('mic failed — tap to retry', '#c87070')
      fadeHud(3000)
    }
  }

  if (_micChannel) {
    setTimeout(doStart, 150)
  } else {
    doStart()
  }
}

function stopRecording() {
  if (!_recording) return
  _recording = false

  // Stop the recorder — triggers onstop which sends to whisper
  if (_recorder && _recorder.state !== 'inactive') {
    try { _recorder.stop() } catch {}
  }
  _recorder = null

  // Release the mic so other tabs/apps can use it
  releaseStream()

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

  if (_activeSendFn) {
    _activeSendFn(_activeSendTargets, text)
  } else {
    import('./fleet-data.mjs').then(({ sendMessage }) => {
      for (const t of _activeSendTargets) sendMessage(t, text)
    })
  }

  const who = targetLabel()
  showHud(`sent → ${who}`, '#7ab8a0')
  fadeHud(2500)

  // Clear textarea and bump generation so in-flight whisper responses are discarded
  ta.value = ''
  ta.style.height = 'auto'
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  _generation++
}

// --- Key Binding ---

let _initialized = false

export function initVoice() {
  if (_initialized) return true
  _initialized = true

  // Right Shift: tap = toggle recording, double-tap = send
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'ShiftRight') return
    e.preventDefault()
    e.stopImmediatePropagation()

    const now = Date.now()
    const gap = now - _lastTapTime
    _lastTapTime = now

    clearTimeout(_singleTapTimer)

    if (gap < DOUBLE_TAP_MS) {
      sendCurrentText()
      _lastTapTime = 0
    } else {
      _singleTapTimer = setTimeout(() => {
        if (_recording) {
          stopRecording()
        } else {
          startRecording()
        }
      }, DOUBLE_TAP_MS)
    }
  }, true)

  // Cross-tab: when another tab starts recording, stop ours
  if (_micChannel) {
    _micChannel.onmessage = (e) => {
      if (e.data === 'mic-start') stopRecording()
    }
  }

  console.log('voice: initialized v5 — whisper.cpp + MediaRecorder — Right Shift tap to toggle, double-tap to send')
  return true
}

// --- Public controls ---

export function toggleRecording() {
  if (_recording) { stopRecording() } else { startRecording() }
}

export { sendCurrentText }

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
  // Bump generation — any in-flight whisper requests will be discarded
  _generation++
  if (_activeTextarea) {
    _activeTextarea.value = ''
    _activeTextarea.style.height = 'auto'
    _activeTextarea.dispatchEvent(new Event('input', { bubbles: true }))
  }
}
