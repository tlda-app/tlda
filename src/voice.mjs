// voice.mjs — Voice input for fleet chat.
//
// Right Shift: tap to toggle recording.
// Transcription fills the active chat textarea — edit before sending.
// Backend: local whisper.cpp server (preferred) or Web Speech API (fallback).
//
// Usage:
//   import { initVoice, setVoiceTarget } from './voice.mjs'
//   initVoice()
//   // When user focuses a chat input:
//   setVoiceTarget(textarea, sendTargets, agentNames)

import { appendToken } from './authToken.ts'

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const _isSafari = !navigator.userAgent.includes('Chrome') && navigator.userAgent.includes('Safari')
const _isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

// --- Backend selection ---
const WHISPER_BRIDGE_URL = location.protocol === 'https:' ? 'wss://127.0.0.1:8179' : 'ws://127.0.0.1:8179'

// Deepgram bridge URL. On the server's own machine we reach the bridge directly
// at 127.0.0.1:8179. From another device (the iPad over Tailscale/LAN) localhost
// is the iPad itself — no bridge there — so relay through a same-origin WS proxy
// on the tlda server (/voice/deepgram), reusing the page's TLS + token. This is
// what keeps the iPad off iOS Web Speech, whose restart earcon causes the beeping.
const _onServerHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname)
function deepgramBridgeUrl() {
  if (_onServerHost) return WHISPER_BRIDGE_URL
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return appendToken(`${proto}://${location.host}/voice/deepgram`)
}

let _backend = 'deepgram'       // 'deepgram' | 'chrome' | 'whisper-stream'
let _whisperAvailable = false   // true if whisper bridge WebSocket connected at init
let _deepgramAvailable = false  // true if deepgram bridge WebSocket connected at init

// --- Whisper-stream backend state ---
let _whisperWs = null           // WebSocket connection to whisper-bridge
let _whisperConnected = false   // true when WS is open

// Math mode — when on, aggressive replacements for Greek letters
// (replaces common English words that sound like Greek letters)
let _mathMode = false

// --- Math/stats vocabulary post-processing ---
// Web Speech API frequently misrecognizes domain-specific terms.
// This map fixes common substitutions after transcription.

// Greek letters and their known Chrome misrecognitions
const GREEK = {
  phi:   ['five', 'fly', 'fire', 'fee', 'fi', 'phi'],
  theta: ['fat a', 'the a', 'theta a', 'theta', 'data', 'feta'],
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
  [/\bfeta\b/gi, 'theta'],
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

  // App name: "tilde" (tlda) — Chrome almost never outputs "tilde",
  // preferring common phrases like "till the", "kill the", etc.
  [/\btill the\b/gi, 'tilde'],
  [/\bkill the\b/gi, 'tilde'],
  [/\bkilda\b/gi, 'tilde'],
  [/\btilled? a\b/gi, 'tilde'],
  [/\bkilled? a\b/gi, 'tilde'],
  [/\btilda\b/gi, 'tilde'],
  [/\btill da\b/gi, 'tilde'],

  // Notation modifiers
  [/\bsuper ?script star\b/gi, '*'],

  // Named methods / frameworks
  [/\bbreck ?man\b/gi, 'Bregman'],
  [/\bbreg ?man\b/gi, 'Bregman'],
  [/\bberkman\b/gi, 'Bregman'],
  [/\bpregnant\b/gi, 'Bregman'],
  [/\breese\b/gi, 'Riesz'],
  [/\breeze\b/gi, 'Riesz'],
  [/\brees\b/gi, 'Riesz'],
  [/\bar ?k ?h ?s\b/gi, 'RKHS'],
  [/\barchitis\b/gi, 'RKHS'],
  [/\bark iss\b/gi, 'RKHS'],
  [/\bdonohoe\b/gi, 'Donoho'],
  [/\bemily\b/gi, 'AMLE'],
  [/\bhershberg\b/gi, 'Hirshberg'],
  [/\bvager\b/gi, 'Wager'],
  [/\bmatern\b/gi, 'Matérn'],
  [/\bsobo ?lev\b/gi, 'Sobolev'],
  [/\bso will have\b/gi, 'Sobolev'],
  [/\bsober of\b/gi, 'Sobolev'],
  [/\bsobolef\b/gi, 'Sobolev'],
  [/\bso bella?\b/gi, 'Sobolev'],
  [/\bso below\b/gi, 'Sobolev'],

  // Math terms
  [/\blima\b/gi, 'lemma'],
  [/\blemon\b/gi, 'lemma'],
  [/\bdilemma\b/gi, 'the lemma'],

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

// --- State machine: 'edit' | 'speech' ---
// edit:   Chrome buffer clean, user may be typing. onresult events ignored.
// speech: Chrome active, voice fills textarea at cursor.
let _state = 'edit'
// Text split around cursor at moment of Speech entry:
let _left = ''    // frozen text before cursor
let _interim = '' // Chrome's current interim result
let _right = ''   // frozen text after cursor
// Legacy aliases — used by send/watchdog code below, kept for compatibility
// _left replaces _finalTranscript, _interim replaces _interimTranscript
Object.defineProperty(globalThis, '__voiceCompat', { value: true })

let _filling = false
let _editStopped = false  // true after enterEdit() calls stop(), false after onend
let _inputListeners = null // { input, click, keydown } handlers for cleanup
let _fadeTimer = null
let _lastTapTime = 0
let _singleTapTimer = null
let _audioCaptureRetries = 0
let _lastResultTime = 0  // timestamp of last onresult — used for HUD health color

// Generation counter — bumped whenever _left is cleared (send, chat-switch,
// startRecording, setVoiceTarget). Each _setupRecognition() snapshots the
// current value; onresult discards callbacks from an older generation.
// Prevents stale in-flight results from writing to the textarea after a send.
let _generation = 0

// Active chat target
let _activeTextarea = null
let _activeSendTargets = []
let _activeAgentNames = {}
let _activeAgentColor = null
let _activeSendFn = null

// Accumulator target — alternative to _activeTextarea for code editors etc.
// When set, fillTextarea() calls onUpdate instead of writing to a DOM element.
// { onUpdate(text), onSend(text)|null, onStop()|null, label } | null
let _accumulator = null

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

// Health dot: green at 20% when audio is flowing, amber at 40% when no audio.
// Both states are visible while recording — green = hearing you, amber = not hearing you.
// Dot is hidden when not recording.
const DOT_GREEN = '#7ab8a0'
const DOT_AMBER = '#c8956a'
const DOT_GREEN_OPACITY = '0.4'
const DOT_AMBER_OPACITY = '0.4'
const AUDIO_FLOWING_MS = 3000  // switch to amber after this long without a result
let _healthDot = null
let _healthDotTimer = null

function ensureHealthDot() {
  if (_healthDot) return _healthDot
  _healthDot = document.createElement('span')
  Object.assign(_healthDot.style, {
    display: 'none',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    marginRight: '6px',
    flexShrink: '0',
    transition: 'opacity 0.3s, background-color 0.3s',
  })
  return _healthDot
}

// --- Textarea glow — shows voice state on the input you're looking at ---
const GLOW_GREEN = 'rgba(122, 184, 160, 0.5)'   // results flowing
const GLOW_AMBER = 'rgba(200, 149, 106, 0.3)'   // recording, silence
const GLOW_RED   = 'rgba(200, 112, 112, 0.5)'   // error
let _glowTimer = null

function setTextareaGlow(color) {
  const ta = _activeTextarea
  if (!ta) return
  // Keep the 2px ring ALWAYS present — transparent when idle — so only the
  // colour ever changes, never the geometry. Toggling box-shadow between '' and
  // '0 0 0 2px' made the ring pop in/out on every record-start/stop, which reads
  // as the border "changing size" / bouncing. A constant-size ring transitions
  // colour-only and never moves.
  ta.style.transition = 'box-shadow 0.3s'
  ta.style.boxShadow = `0 0 0 2px ${color || 'transparent'}`
}

// Call when onresult fires — audio is flowing
function dotAudioFlowing() {
  if (!_recording) return
  hideDontSpeak()
  const dot = ensureHealthDot()
  dot.style.display = 'inline-block'
  dot.style.backgroundColor = DOT_GREEN
  requestAnimationFrame(() => { dot.style.opacity = DOT_GREEN_OPACITY })
  setTextareaGlow(GLOW_GREEN)
  // Schedule transition to amber after silence
  clearTimeout(_healthDotTimer)
  _healthDotTimer = setTimeout(dotAudioStale, AUDIO_FLOWING_MS)
}

// Audio went stale — no results for AUDIO_FLOWING_MS
function dotAudioStale() {
  if (!_recording) return
  const dot = ensureHealthDot()
  dot.style.backgroundColor = DOT_AMBER
  dot.style.opacity = DOT_AMBER_OPACITY
  setTextareaGlow(GLOW_AMBER)
}

// Show amber dot immediately (recording started, no audio yet)
function dotRecordingStart() {
  const dot = ensureHealthDot()
  dot.style.display = 'inline-block'
  dot.style.backgroundColor = DOT_AMBER
  requestAnimationFrame(() => { dot.style.opacity = DOT_AMBER_OPACITY })
  setTextareaGlow(GLOW_AMBER)
}

function showErrorGlow() {
  setTextareaGlow(GLOW_RED)
}

function hideHealthDot() {
  clearTimeout(_healthDotTimer)
  _healthDotTimer = null
  clearTimeout(_glowTimer)
  _glowTimer = null
  hideDontSpeak()
  setTextareaGlow(null)
  if (_healthDot) {
    _healthDot.style.opacity = '0'
    setTimeout(() => { if (_healthDot) _healthDot.style.display = 'none' }, 300)
  }
}

// --- Giant "DON'T SPEAK" overlay when voice is dead ---
let _dontSpeakOverlay = null

function ensureDontSpeakOverlay() {
  if (_dontSpeakOverlay) return _dontSpeakOverlay
  _dontSpeakOverlay = document.createElement('div')
  Object.assign(_dontSpeakOverlay.style, {
    display: 'none',
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    zIndex: '999999',
    fontSize: '48px',
    fontWeight: 'bold',
    textAlign: 'center',
    background: 'rgba(200, 50, 50, 0.85)',
    color: 'white',
    padding: '20px',
    pointerEvents: 'none',
  })
  _dontSpeakOverlay.textContent = '\u{1F507} DON’T SPEAK'
  document.body.appendChild(_dontSpeakOverlay)
  return _dontSpeakOverlay
}

function showDontSpeak() {
  if (!_recording) return
  const el = ensureDontSpeakOverlay()
  el.style.display = 'block'
}

function hideDontSpeak() {
  if (_dontSpeakOverlay) _dontSpeakOverlay.style.display = 'none'
}

function showHud(text, stateColor) {
  const hud = ensureHud()
  clearTimeout(_fadeTimer)
  // Build HUD content with health dot + text
  const dot = ensureHealthDot()
  hud.textContent = ''
  hud.style.display = 'flex'
  hud.style.alignItems = 'center'
  hud.appendChild(dot)
  const span = document.createElement('span')
  span.textContent = text
  hud.appendChild(span)
  hud.style.color = _activeAgentColor || stateColor || 'rgba(255,255,255,0.7)'
  requestAnimationFrame(() => { hud.style.opacity = '1' })
}

// Show recording status — text uses agent color, dot shows health separately
function showRecordingHud() {
  const who = targetLabel()
  const mode = _mathMode ? ' [math]' : ''
  const be = _backend === 'deepgram' ? ' [deepgram]' : _backend === 'whisper-stream' ? ' [whisper]' : ''
  const text = who ? `recording → ${who}${mode}${be}` : `recording${mode}${be}`
  showHud(text, '#c87070')
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

// Enter Edit state — accept current textarea as ground truth, stop Chrome.
// Safe to call multiple times (idempotent after first call per editing session).
function enterEdit() {
  if (_state === 'edit') return
  // Whisper-stream: flush the bridge — drops old audio output for ~4s
  // so text the user just edited doesn't get overwritten.
  // Show amber glow so user knows voice is suppressed.
  if (_backend === 'whisper-stream') {
    whisperLog(`enterEdit — flushing, gen=${_generation}`)
    flushWhisperBridge()
    setTextareaGlow(GLOW_AMBER)
  }
  if (_backend === 'deepgram') {
    _deepgramInterim = ''
    _dgHasSeenInterim = false
    _dgTrickleFlush()
    _dgTrickleWords = []
    _dgTrickleShown = 0
    setTextareaGlow(GLOW_AMBER)
  }
  _state = 'edit'
  _generation++
  _left = _interim = _right = ''
  if (_recording && _recognition) {
    _editStopped = true
    try { _recognition.stop() } catch {}
  }
}

export function setVoiceTarget(textarea, sendTargets, agentNames, sendFn, agentColor) {
  let wasRecording = false
  if (textarea !== _activeTextarea) {
    // Hard reset voice on chat switch — same as double-shift-right.
    // Without this, the old recognition session keeps running with a stale
    // generation and onresult discards everything, making voice appear dead.
    wasRecording = _recording
    vlog('setVoiceTarget: switching chat', { wasRecording, backend: _backend, wsOpen: _deepgramConnected, hasMic: !!_deepgramStream })
    if (_backend === 'whisper-stream') flushWhisperBridge()
    if (_backend === 'deepgram') _deepgramInterim = ''
    hardResetVoice({ keepDeepgramMic: true })
    // Remove old listeners
    if (_inputListeners && _activeTextarea) {
      _activeTextarea.removeEventListener('input', _inputListeners.input)
      _activeTextarea.removeEventListener('click', _inputListeners.click)
      _activeTextarea.removeEventListener('keydown', _inputListeners.keydown)
      _inputListeners = null
    }
    _state = 'edit'
    _left = _interim = _right = ''
    if (textarea) {
      const onEdit = () => { if (!_filling) enterEdit() }
      const onKeydown = (e) => {
        if (_filling) return
        // Plain Enter sends the message. The stop→onend→start restart path is
        // unreliable in Safari (webkitSpeechRecognition silently fails to resume),
        // so do the same thing double-tap-right-shift does: hardResetVoice + start.
        // Suppress the textarea-clear input event that would otherwise call enterEdit().
        if (e.key === 'Enter' && !e.shiftKey && _recording) {
          _filling = true
          afterSend()
          setTimeout(() => { _filling = false }, 50)
          return
        }
        if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) {
          enterEdit()
        }
      }
      textarea.addEventListener('input', onEdit)
      textarea.addEventListener('click', onEdit)
      textarea.addEventListener('keydown', onKeydown)
      _inputListeners = { input: onEdit, click: onEdit, keydown: onKeydown }
    }
  }
  _activeTextarea = textarea
  _activeSendTargets = sendTargets || []
  _activeAgentNames = agentNames || {}
  _activeAgentColor = agentColor || null
  _activeSendFn = sendFn || null
  // Prime the always-present transparent ring so the first record-start is a
  // colour-only transition, not a 0→2px geometry pop (see setTextareaGlow).
  if (textarea && !textarea.style.boxShadow) textarea.style.boxShadow = '0 0 0 2px transparent'
  // If voice was recording before the chat switch, restart it on the new target
  if (wasRecording && textarea) {
    startRecording()
  } else if (_recording) {
    showRecordingHud()
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

// --- Accumulator target ---
// An alternative to setVoiceTarget for non-textarea editors (CodeMirror etc).
// onUpdate(text) receives the post-processed spoken text so far.
// onSend(text)   called when the "send" voice keyword is detected (optional).
// onStop()       called when recording stops, so caller can reset cursor anchor (optional).
// label          shown in HUD, e.g. 'note'.
export function setVoiceAccumulator(onUpdate, onSend, onStop, label) {
  // If same accumulator is already registered, no-op — avoids interrupting an
  // active recording session when focus re-fires (e.g. clicking within CodeMirror).
  if (_accumulator && _accumulator.onUpdate === onUpdate) return
  const wasRecording = _recording
  // Sync teardown — no getUserMedia cycle needed (accumulator switch is cheap)
  if (_recognition) {
    try {
      _recognition.onresult = null
      _recognition.onend = null
      _recognition.onerror = null
      _recognition.onsoundstart = null
      _recognition.abort()
    } catch {}
    _recognition = null
  }
  _recording = false
  // Clear textarea target if one is set
  if (_inputListeners && _activeTextarea) {
    _activeTextarea.removeEventListener('input', _inputListeners.input)
    _activeTextarea.removeEventListener('click', _inputListeners.click)
    _activeTextarea.removeEventListener('keydown', _inputListeners.keydown)
    _inputListeners = null
  }
  _activeTextarea = null
  _state = 'edit'
  _generation++
  _left = _interim = _right = ''
  _accumulator = { onUpdate, onSend: onSend || null, onStop: onStop || null, label: label || 'note' }
  if (wasRecording) startRecording()
}

export function clearVoiceAccumulator(onUpdate) {
  if (_accumulator && _accumulator.onUpdate === onUpdate) {
    _accumulator = null
    if (_recording) stopRecording()
  }
}

// Called when the cursor is moved by the user while an accumulator is active.
// Mirrors enterEdit() — interrupts the current speech session so the next
// session will snapshot the new cursor position on first result.
export function notifyAccumulatorCursorMoved() {
  if (!_accumulator) return
  enterEdit()
}

function targetLabel() {
  if (_accumulator) return _accumulator.label || 'note'
  if (_activeSendTargets.length === 0) return null
  return _activeSendTargets
    .map(id => _activeAgentNames[id] || id.replace('fleet:', ''))
    .join(', ')
}

// --- Fill textarea with transcription ---

function fillTextarea(text) {
  if (_accumulator) {
    // Accumulator mode: deliver post-processed spoken text to the callback.
    // The caller (CodeMirror, etc.) manages cursor/insertion itself.
    _accumulator.onUpdate(postProcessTranscript(_left + _interim))
    return
  }
  const ta = _activeTextarea
  if (!ta) return
  _filling = true
  ta.value = postProcessTranscript(text)
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  // Restore cursor to end of voice portion (between interim and right)
  // Use length of processed text minus right portion
  if (_state === 'speech' && _right.length > 0) {
    const processed = postProcessTranscript(text)
    const cursorPos = processed.length - _right.length
    ta.setSelectionRange(cursorPos, cursorPos)
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  _filling = false
}

// --- Speech Recognition ---

function _setupRecognition() {
  // Snapshot the generation at setup time. Any onresult that arrives after
  // _generation has been bumped (send, chat-switch, target-change, start) is
  // from a stale session and will be discarded before touching the textarea.
  const myGeneration = _generation

  _recognition = new SpeechRecognition()
  _recognition.continuous = true
  _recognition.interimResults = true
  _recognition.lang = 'en-US'

  _recognition.onresult = (e) => {
    // Discard results from a stale session (generation bumped since setup).
    if (_generation !== myGeneration) return

    _lastResultTime = Date.now()
    dotAudioFlowing()

    // Edit state: transition to Speech on first result (entering speech)
    // Exception: if stop() was called by enterEdit(), discard until onend fires
    if (_state === 'edit') {
      if (_editStopped) return  // stale results after user edit — discard
      // First result since recording started — transition to Speech
    }

    // Speech entry: freeze cursor position on first result of this speech session
    if (_state !== 'speech') {
      _state = 'speech'
      const cursor = _activeTextarea?.selectionStart ?? (_activeTextarea?.value?.length ?? 0)
      _left = _activeTextarea?.value?.slice(0, cursor) ?? ''
      _right = _activeTextarea?.value?.slice(cursor) ?? ''
      _interim = ''
    }

    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        _left += e.results[i][0].transcript
      } else {
        interim += e.results[i][0].transcript
      }
    }
    _interim = interim

    if (e.results[e.results.length - 1]?.isFinal) {
      const leftTrimmed = _left.trim()

      // Voice-switch: "left chat"/"right chat" at end of text
      const switchMatch = leftTrimmed.match(/(right|write|great|left|next|other)\s+chat\s*[.!,]?\s*$/i)
      if (switchMatch) {
        const textareas = [...document.querySelectorAll('.fleet-chat-shape textarea')]
          .filter(ta => ta.offsetHeight > 0)
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        const target = textareas.find(ta => ta !== _activeTextarea) || textareas[0]
        if (target) {
          target.focus()
          showHud('→ other chat', '#9370db')
          fadeHud(1500)
          _state = 'edit'
          _generation++
          _left = _interim = _right = ''
          // Force a fresh session so cumulative results from the previous
          // chat can't leak into the new chat's textarea.
          if (_recording && _recognition) {
            _editStopped = true
            try { _recognition.stop() } catch {}
          }
          setTimeout(() => {
            if (_recording) showRecordingHud()
          }, 1600)
          return
        }
      }

      // Voice-send: "send" / "send it" / "sent" at end of text
      const sendMatch = leftTrimmed.match(/(send\s*it|send|sent)\s*[.!,]?\s*$/i)
      if (sendMatch) {
        const cleanText = leftTrimmed.slice(0, sendMatch.index).trim()
        if (cleanText && _accumulator && _accumulator.onSend) {
          _accumulator.onSend(cleanText)
          showHud('sent', '#7ab8a0')
          fadeHud(2500)
          afterSend()
          return
        }
        if (cleanText && _activeSendTargets.length > 0 && _activeSendFn) {
          const who = targetLabel()
          const wordCount = cleanText.split(/\s+/).length
          _filling = true
          if (_activeTextarea) {
            _activeTextarea.value = ''
            _activeTextarea.style.height = 'auto'
          }
          _filling = false
          _activeSendFn(_activeSendTargets, cleanText)
          showHud(`sent ${wordCount} words → ${who}`, '#7ab8a0')
          fadeHud(2500)
          afterSend()
          return
        }
      }
    }

    fillTextarea(_left + _interim + _right)
  }

  _recognition.onerror = (e) => {
    if (e.error === 'no-speech') return
    if (e.error === 'aborted') return
    console.warn('voice: speech recognition error', e.error)
    showErrorGlow()
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
          showRecordingHud()
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
          showRecordingHud()
        } catch (err) {
          console.warn('voice: retry failed', err)
          showHud('mic failed — tap shift', '#c87070')
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
      // Commit any pending interim to left so it survives the restart
      if (_state === 'speech' && _interim) {
        _left += _interim
        _interim = ''
      }
      _editStopped = false  // new session starting — ready for speech again
      // If generation was bumped since this session was set up (e.g. chat-switch
      // or send keyword called _generation++ before our stop() triggered onend),
      // create a new SpeechRecognition object so its onresult closure captures
      // the current _generation. Without this, the restarted session would still
      // have the old myGeneration snapshot and discard every result it receives.
      if (_generation !== myGeneration) {
        _setupRecognition()
      }
      try {
        _recognition.start()
      } catch (err) {
        if (err.name !== 'InvalidStateError') throw err
        setTimeout(() => { if (_recording) _recognition.start() }, 100)
      }
    }
  }
}

// --- Whisper-stream backend ---
// Connects to whisper-bridge WebSocket (ws://localhost:8179).
// whisper-stream captures mic directly and transcribes in real-time.
// Each message is a new chunk of text — append to _left.
// No MediaRecorder, no WAV conversion, no browser mic needed.

function cleanWhisperText(text) {
  return text
    .replace(/\[BLANK_AUDIO\]/gi, '')
    .replace(/\[silence\]/gi, '')
    .replace(/\([^)]{0,30}\)/g, '')  // strip parenthetical annotations
    .replace(/\.{3,}/g, '')
    .replace(/Thank you for watching[.!]?/gi, '')
    .replace(/Thanks for watching[.!]?/gi, '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function onWhisperMessage(event) {
  if (!_recording || _backend !== 'whisper-stream') return
  try {
    const msg = JSON.parse(event.data)
    if (msg.type !== 'transcript' || !msg.text) return
    const text = cleanWhisperText(msg.text)
    if (!text) return

    _lastResultTime = Date.now()
    dotAudioFlowing()
    whisperLog(`msg: state=${_state} text="${text.slice(0,40)}"`)

    // Enter speech state on first result — snapshot cursor position
    if (_state !== 'speech') {
      _state = 'speech'
      const ta = _activeTextarea
      const cursor = ta?.selectionStart ?? (ta?.value?.length ?? 0)
      _left = ta?.value?.slice(0, cursor) ?? ''
      _right = ta?.value?.slice(cursor) ?? ''
      _interim = ''
    }

    // Append new transcription chunk to _left — once committed, text doesn't change
    const processed = postProcessTranscript(text)
    _left += (_left.length && !_left.endsWith(' ') ? ' ' : '') + processed
    _interim = ''

    const leftTrimmed = _left.trim()

    // Voice-switch: "left chat"/"right chat"
    const switchMatch = leftTrimmed.match(/(right|write|great|left|next|other)\s+chat\s*[.!,]?\s*$/i)
    if (switchMatch) {
      const textareas = [...document.querySelectorAll('.fleet-chat-shape textarea')]
        .filter(ta => ta.offsetHeight > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      const target = textareas.find(ta => ta !== _activeTextarea) || textareas[0]
      if (target) {
        target.focus()
        showHud('→ other chat', '#9370db')
        fadeHud(1500)
        _state = 'edit'
        _generation++
        _left = _interim = _right = ''
        flushWhisperBridge()
        setTimeout(() => { if (_recording) showRecordingHud() }, 1600)
        return
      }
    }

    // Voice-send: "send" / "send it" / "sent"
    const sendMatch = leftTrimmed.match(/(send\s*it|send|sent)\s*[.!,]?\s*$/i)
    if (sendMatch) {
      const cleanText = leftTrimmed.slice(0, sendMatch.index).trim()
      if (cleanText && _accumulator && _accumulator.onSend) {
        _accumulator.onSend(cleanText)
        showHud('sent', '#7ab8a0')
        fadeHud(2500)
        afterSend()
        return
      }
      if (cleanText && _activeSendTargets.length > 0 && _activeSendFn) {
        const who = targetLabel()
        const wordCount = cleanText.split(/\s+/).length
        _filling = true
        if (_activeTextarea) {
          _activeTextarea.value = ''
          _activeTextarea.style.height = 'auto'
        }
        _filling = false
        _activeSendFn(_activeSendTargets, cleanText)
        showHud(`sent ${wordCount} words → ${who}`, '#7ab8a0')
        fadeHud(2500)
        afterSend()
        return
      }
    }

    fillTextarea(_left + _interim + _right)
  } catch (err) {
    console.warn('voice: whisper message error', err)
  }
}

function connectWhisperBridge() {
  if (_whisperWs) return
  try {
    _whisperWs = new WebSocket(WHISPER_BRIDGE_URL)
    _whisperWs.onopen = () => {
      _whisperConnected = true
      console.log('voice: connected to whisper bridge')
    }
    _whisperWs.onmessage = onWhisperMessage
    _whisperWs.onclose = () => {
      _whisperConnected = false
      _whisperWs = null
      // Don't auto-reconnect — Safari shows mic permission dialogs for
      // each new WebSocket connection. Reconnect only on next recording start.
    }
    _whisperWs.onerror = () => {} // onclose handles reconnect
  } catch {
    _whisperWs = null
  }
}

function flushWhisperBridge() {
  if (_whisperWs && _whisperConnected) {
    try { _whisperWs.send(JSON.stringify({ type: 'flush' })) } catch {}
  }
}

function whisperLog(text) {
  console.log('voice:', text)
  if (_whisperWs && _whisperConnected) {
    try { _whisperWs.send(JSON.stringify({ type: 'log', text })) } catch {}
  }
}

function disconnectWhisperBridge() {
  if (_whisperWs) {
    _whisperWs.onclose = null // prevent reconnect
    _whisperWs.close()
    _whisperWs = null
    _whisperConnected = false
  }
}

// --- Deepgram backend ---
// Browser captures mic via AudioWorklet, sends raw PCM to deepgram-bridge (ws:8179).
// Bridge relays to Deepgram API and returns transcripts with is_final flags.
// No echo/doubling — Deepgram manages interim vs final results cleanly.

let _deepgramWs = null
let _deepgramConnected = false
let _deepgramStream = null      // MediaStream from getUserMedia
let _deepgramContext = null      // AudioContext
let _deepgramProcessor = null    // ScriptProcessorNode (bridge to WS)
let _deepgramInterim = ''        // current interim result (replaced on each interim)
let _dgHasSeenInterim = false   // true after first interim in current session; guards against post-send final bleed
let _lastAudioChunkTime = 0     // timestamp of last audio chunk sent to bridge (for heartbeat logging)
let _audioHeartbeatInterval = null  // periodic interval that logs audio-flow health
let _dgTrickleWords = []         // words currently being trickled in
let _dgTrickleShown = 0          // how many trickle words are visible
let _dgTrickleTimer = null       // setTimeout id for next trickle step
let _dgTrickleDelay = 40         // ms between words (adjusted per burst)

function _dgTrickleFlush() {
  clearTimeout(_dgTrickleTimer)
  _dgTrickleTimer = null
}

function _dgTrickleStep() {
  _dgTrickleTimer = null
  if (_dgTrickleShown >= _dgTrickleWords.length) return
  _dgTrickleShown++
  _interim = postProcessTranscript(_dgTrickleWords.slice(0, _dgTrickleShown).join(' '))
  const display = _left + (_interim ? ' ' + _interim : '') + _right
  fillTextarea(display)
  if (_dgTrickleShown < _dgTrickleWords.length) {
    _dgTrickleTimer = setTimeout(_dgTrickleStep, _dgTrickleDelay)
  }
}

function onDeepgramMessage(event) {
  if (!_recording || _backend !== 'deepgram') {
    try {
      const m = JSON.parse(event.data)
      if (m.type === 'transcript' && m.text) vlog('DROPPED transcript (not recording)', { text: m.text.slice(0, 30) })
    } catch {}
    return
  }
  try {
    const msg = JSON.parse(event.data)

    if (msg.type === 'status') {
      console.log('voice: deepgram status:', msg.status)
      return
    }

    if (msg.type === 'utterance_end') {
      _dgTrickleFlush()
      if (_deepgramInterim) {
        _deepgramInterim = ''
        _interim = ''
        _dgTrickleWords = []
        _dgTrickleShown = 0
        fillTextarea(_left + _right)
      }
      return
    }

    if (msg.type !== 'transcript' || !msg.text) return

    // Discard finals that arrive after afterSend() cleared the session but before
    // the user speaks again. Without this, the last utterance of the previous
    // message bleeds into the new one.
    if (msg.is_final && !_dgHasSeenInterim && _state === 'edit') return

    _lastResultTime = Date.now()
    dotAudioFlowing()

    if (_state !== 'speech') {
      _state = 'speech'
      const ta = _activeTextarea
      const cursor = ta?.selectionStart ?? (ta?.value?.length ?? 0)
      _left = ta?.value?.slice(0, cursor) ?? ''
      _right = ta?.value?.slice(cursor) ?? ''
      _deepgramInterim = ''
      _dgTrickleFlush()
      _dgTrickleWords = []
      _dgTrickleShown = 0
    }

    const text = msg.text

    if (msg.is_final) {
      // Final result — append to committed text, clear interim
      _dgTrickleFlush()
      const processed = postProcessTranscript(text)
      _left += (_left.length && !_left.endsWith(' ') ? ' ' : '') + processed
      _deepgramInterim = ''
      _interim = ''
      _dgTrickleWords = []
      _dgTrickleShown = 0
      _dgHasSeenInterim = false  // reset for next utterance
    } else {
      // Interim — trickle new words in one at a time, smoothed
      _deepgramInterim = text
      _dgHasSeenInterim = true   // saw an interim → finals for this utterance are valid
      const newWords = text.split(/\s+/).filter(Boolean)
      const prevLen = _dgTrickleWords.length
      _dgTrickleWords = newWords
      if (_dgTrickleShown > newWords.length) _dgTrickleShown = newWords.length
      const pending = newWords.length - _dgTrickleShown
      if (pending > 0 && newWords.length > prevLen && _dgTrickleShown >= prevLen) {
        // Spread burst over ~200ms so pace feels even (min 30ms, max 90ms per word)
        _dgTrickleDelay = Math.max(30, Math.min(90, Math.round(200 / pending)))
        // Show first new word immediately for responsiveness
        _dgTrickleShown++
        _interim = postProcessTranscript(newWords.slice(0, _dgTrickleShown).join(' '))
        const display = _left + (_interim ? ' ' + _interim : '') + _right
        fillTextarea(display)
        if (_dgTrickleShown < newWords.length && !_dgTrickleTimer) {
          _dgTrickleTimer = setTimeout(_dgTrickleStep, _dgTrickleDelay)
        }
      } else {
        _interim = postProcessTranscript(newWords.slice(0, _dgTrickleShown).join(' '))
      }
    }

    const leftTrimmed = (_left + (_deepgramInterim ? ' ' + postProcessTranscript(_deepgramInterim) : '')).trim()

    // Voice-switch
    const switchMatch = leftTrimmed.match(/(right|write|great|left|next|other)\s+chat\s*[.!,]?\s*$/i)
    if (switchMatch) {
      const textareas = [...document.querySelectorAll('.fleet-chat-shape textarea')]
        .filter(ta => ta.offsetHeight > 0)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      const target = textareas.find(ta => ta !== _activeTextarea) || textareas[0]
      if (target) {
        target.focus()
        showHud('→ other chat', '#9370db')
        fadeHud(1500)
        _state = 'edit'
        _generation++
        _left = _interim = _right = ''
        _deepgramInterim = ''
        _dgTrickleFlush()
        _dgTrickleWords = []
        _dgTrickleShown = 0
        setTimeout(() => { if (_recording) showRecordingHud() }, 1600)
        return
      }
    }

    // Voice-send
    const sendMatch = leftTrimmed.match(/(send\s*it|send|sent)\s*[.!,]?\s*$/i)
    if (sendMatch) {
      const cleanText = leftTrimmed.slice(0, sendMatch.index).trim()
      if (cleanText && _accumulator && _accumulator.onSend) {
        _accumulator.onSend(cleanText)
        showHud('sent', '#7ab8a0')
        fadeHud(2500)
        afterSend()
        return
      }
      if (cleanText && _activeSendTargets.length > 0 && _activeSendFn) {
        const who = targetLabel()
        const wordCount = cleanText.split(/\s+/).length
        _filling = true
        if (_activeTextarea) {
          _activeTextarea.value = ''
          _activeTextarea.style.height = 'auto'
        }
        _filling = false
        _activeSendFn(_activeSendTargets, cleanText)
        showHud(`sent ${wordCount} words → ${who}`, '#7ab8a0')
        fadeHud(2500)
        afterSend()
        return
      }
    }

    // Display: committed text + space + interim
    const display = _left + (_interim ? ' ' + _interim : '') + _right
    fillTextarea(display)
  } catch (err) {
    console.warn('voice: deepgram message error', err)
  }
}

function connectDeepgramBridge() {
  if (_deepgramWs && _deepgramWs.readyState === WebSocket.OPEN) return
  if (_deepgramWs) {
    _deepgramWs.onclose = null
    try { _deepgramWs.close() } catch {}
    _deepgramWs = null
  }
  try {
    _deepgramWs = new WebSocket(deepgramBridgeUrl())
    _deepgramWs.onopen = () => {
      _deepgramConnected = true
      hideDontSpeak()
      vlog('bridge WS open')
      _deepgramWs.send(JSON.stringify({ type: 'start' }))
    }
    _deepgramWs.onmessage = onDeepgramMessage
    _deepgramWs.onclose = () => {
      _deepgramConnected = false
      _deepgramWs = null
      vlog('bridge WS closed', { recording: _recording })
      showDontSpeak()
      if (_recording && _backend === 'deepgram') {
        vlog('bridge auto-reconnect in 1s')
        setTimeout(connectDeepgramBridge, 1000)
      }
    }
    _deepgramWs.onerror = (err) => { vlog('bridge WS error', { message: err?.message || 'unknown' }) }
  } catch {
    _deepgramWs = null
  }
}

function disconnectDeepgramBridge() {
  stopDeepgramMic()
  if (_deepgramWs) {
    if (_deepgramConnected) {
      try { _deepgramWs.send(JSON.stringify({ type: 'stop' })) } catch {}
    }
    _deepgramWs.onclose = null
    _deepgramWs.close()
    _deepgramWs = null
    _deepgramConnected = false
  }
}

async function startDeepgramMic() {
  if (_deepgramStream) return

  try {
    _deepgramStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
    })
  } catch (err) {
    console.error('voice: deepgram mic access failed', err)
    showHud('mic denied — check permissions', '#c87070')
    fadeHud(5000)
    return
  }

  // Auto-recover if the mic track ends unexpectedly
  const track = _deepgramStream.getAudioTracks()[0]
  if (track) {
    track.onended = () => {
      vlog('mic track ended — OS killed mic', { recording: _recording, backend: _backend })
      stopDeepgramMic()
      if (_recording && _backend === 'deepgram') {
        setTimeout(() => startDeepgramMic(), 500)
      }
    }
  }

  _deepgramContext = new AudioContext()
  if (_deepgramContext.state === 'suspended') {
    await _deepgramContext.resume()
  }
  const nativeSr = _deepgramContext.sampleRate
  const targetSr = 16000
  const source = _deepgramContext.createMediaStreamSource(_deepgramStream)

  _deepgramProcessor = _deepgramContext.createScriptProcessor(4096, 1, 1)
  _deepgramProcessor.onaudioprocess = (e) => {
    if (!_deepgramWs || !_deepgramConnected || !_recording) return
    _lastAudioChunkTime = Date.now()
    const float32 = e.inputBuffer.getChannelData(0)

    // Downsample if needed (e.g. 48000 → 16000)
    let samples = float32
    if (nativeSr !== targetSr) {
      const ratio = nativeSr / targetSr
      const newLen = Math.floor(float32.length / ratio)
      samples = new Float32Array(newLen)
      for (let i = 0; i < newLen; i++) {
        samples[i] = float32[Math.floor(i * ratio)]
      }
    }

    // Convert Float32 [-1,1] to Int16
    const int16 = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
    }
    try { _deepgramWs.send(int16.buffer) } catch {}
  }

  source.connect(_deepgramProcessor)
  _deepgramProcessor.connect(_deepgramContext.destination)

  _lastAudioChunkTime = 0
  _audioHeartbeatInterval = setInterval(() => {
    if (!_recording) return
    const ago = _lastAudioChunkTime ? Date.now() - _lastAudioChunkTime : null
    vlog('audio heartbeat', {
      lastChunkMs: ago,
      wsOpen: _deepgramConnected,
      hasMic: !!_deepgramStream,
      audioCtxState: _deepgramContext?.state,
    })
    // Resume AudioContext if it got suspended (tab backgrounded, OS audio pause, etc.)
    if (_deepgramContext?.state === 'suspended') {
      vlog('audio heartbeat: AudioContext suspended — resuming')
      _deepgramContext.resume().then(() => {
        vlog('audio heartbeat: AudioContext resumed')
      }).catch(err => vlog('audio heartbeat: resume failed', { err: err.message }))
    }
    // If audio stopped flowing for >2s despite recording, restart the mic pipeline.
    // onaudioprocess fires even during silence, so stale lastChunkMs means the
    // AudioContext or ScriptProcessor died without us noticing.
    if (ago !== null && ago > 2000) {
      vlog('audio heartbeat: no audio for 2s — restarting mic pipeline')
      showDontSpeak()
      stopDeepgramMic()
      startDeepgramMic()
    }
  }, 1000)
}

function stopDeepgramMic() {
  clearInterval(_audioHeartbeatInterval)
  _audioHeartbeatInterval = null
  if (_deepgramProcessor) {
    _deepgramProcessor.disconnect()
    _deepgramProcessor = null
  }
  if (_deepgramContext) {
    _deepgramContext.close().catch(e => console.warn('[voice] AudioContext close failed:', e.message))
    _deepgramContext = null
  }
  if (_deepgramStream) {
    for (const track of _deepgramStream.getTracks()) {
      try { track.stop() } catch {}
    }
    _deepgramStream = null
  }
}

// --- After-send state reset ---
// Called after any send (Enter key or voice-send keyword) to prepare for the
// next message. Resets text buffers and handles recognition restart.
// One function, called from all send paths — no parallel implementations.
function afterSend() {
  _state = 'edit'
  _left = _interim = _right = ''
  _deepgramInterim = ''
  _dgHasSeenInterim = false
  if (_backend === 'whisper-stream') {
    flushWhisperBridge()
    return
  }
  if (_backend === 'deepgram') {
    _dgTrickleFlush()
    _dgTrickleWords = []
    _dgTrickleShown = 0
    // Deepgram: close and reopen the session for a clean slate
    if (_deepgramWs && _deepgramConnected) {
      _deepgramWs.send(JSON.stringify({ type: 'stop' }))
      setTimeout(() => {
        if (_recording && _deepgramWs && _deepgramConnected) {
          _deepgramWs.send(JSON.stringify({ type: 'start' }))
        }
      }, 200)
    }
    return
  }
  if (!_recording) return
  if (_isSafari) {
    // Safari: webkitSpeechRecognition is unreliable after stop/start; full reset needed.
    hardResetVoice().then(() => startRecording())
  } else {
    // Chrome: keep recognition running — no restart gap, no warmup delay.
    // _editStopped gates the next 100ms to drop any in-flight finals from the
    // old message; after that the next word starts a fresh message naturally.
    _editStopped = true
    setTimeout(() => { _editStopped = false }, 100)
  }
}

// --- Recording ---

// Remote debug logging — sends voice logs to server so agent can read them.
// Whisper backend forwards via _whisperWs (see receive site at line 940).
// Deepgram backend forwards here when the bridge WS is open; the bridge writes
// `[voice] <text>` to ~/.config/tlda/deepgram-bridge.log so Safari debug is
// observable without Web Inspector / USB pairing.
const _voiceLogs = []
function vlog(msg, data) {
  const entry = data ? `${msg} ${JSON.stringify(data)}` : msg
  console.log('voice:', entry)
  _voiceLogs.push(`${new Date().toISOString().slice(11,19)} ${entry}`)
  if (_voiceLogs.length > 50) _voiceLogs.shift()
  if (_deepgramWs && _deepgramWs.readyState === 1) {
    try { _deepgramWs.send(JSON.stringify({ type: 'log', text: entry })) } catch {}
  }
}
// Expose logs for reading via fetch
if (typeof window !== 'undefined') {
  window.__voiceLogs = _voiceLogs
  window.__voiceTest = {
    fakeRecord: (ta) => { _recording = true; _state = 'edit'; _backend = 'deepgram'; if (ta) _activeTextarea = ta; },
    fakeStop: () => { _recording = false; },
    switchTarget: (ta) => setVoiceTarget(ta, [], {}, null, null),
    getState: () => ({ recording: _recording, backend: _backend, state: _state, connected: _deepgramConnected, hasMic: !!_deepgramStream, left: _left, interim: _interim, hasTextarea: !!_activeTextarea }),
    injectTranscript: (text, isFinal) => onDeepgramMessage({ data: JSON.stringify({ type: 'transcript', text, is_final: isFinal, speech_final: false }) }),
    afterSend: () => afterSend(),
    getTrickle: () => ({ words: _dgTrickleWords.slice(), shown: _dgTrickleShown, hasTimer: _dgTrickleTimer !== null }),
  }
}

function startRecording() {
  vlog('startRecording', { backend: _backend, recording: _recording, hasTextarea: !!_activeTextarea, hasAccumulator: !!_accumulator })
  if (_recording) return
  if (_backend === 'chrome' && !SpeechRecognition) return

  if (!_activeTextarea && !_accumulator) {
    showHud('no chat focused', '#c8956a')
    fadeHud(2000)
    return
  }

  _micChannel?.postMessage('mic-start')

  _recording = true
  _state = 'edit'
  _generation++
  _left = _interim = _right = ''
  _lastResultTime = 0

  showRecordingHud()
  dotRecordingStart()

  _audioCaptureRetries = 0

  if (_backend === 'deepgram') {
    connectDeepgramBridge()
    startDeepgramMic()
    // Ensure Deepgram session is started (may have been stopped by hardResetVoice)
    if (_deepgramWs && _deepgramConnected) {
      try { _deepgramWs.send(JSON.stringify({ type: 'start' })) } catch {}
    }
  } else if (_backend === 'whisper-stream') {
    // whisper-stream captures mic directly — no browser mic needed.
    // Just ensure we're connected to the bridge WebSocket.
    connectWhisperBridge()
  } else {
    const doStart = () => {
      if (!_recording) return
      _setupRecognition()
      try {
        _recognition.start()
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
}

function stopRecording() {
  if (!_recording) return
  _recording = false

  hideHealthDot()

  // Stop Chrome recognition if active
  if (_recognition) {
    _recognition.onresult = null
    _recognition.onend = null
    try { _recognition.stop() } catch {}
    _recognition = null
  }

  // Deepgram: stop mic capture and close session
  if (_backend === 'deepgram') {
    stopDeepgramMic()
    if (_deepgramWs && _deepgramConnected) {
      try { _deepgramWs.send(JSON.stringify({ type: 'stop' })) } catch {}
    }
  }

  // Notify accumulator that recording stopped (caller can reset cursor anchor etc.)
  if (_accumulator?.onStop) _accumulator.onStop()

  const who = targetLabel()
  showHud(who ? `paused → ${who}` : 'paused', '#9370db')
  fadeHud(4000)
}

// Hard reset — the escape hatch for when Chrome's SpeechRecognition
// pipeline is poisoned and normal stop/start won't un-stick it. Triggered
// by double-tap on Right Shift. Aborts any live recognition, clears all
// state, and releases the browser's microphone lock by opening and
// immediately closing a getUserMedia audio stream.
//
// keepDeepgramMic: true skips mic teardown for chat-switch resets.
// The mic stream is stateless — only text state needs clearing on switch.
// Full teardown (getUserMedia round-trip) is reserved for double-tap.
async function hardResetVoice({ keepDeepgramMic = false } = {}) {
  if (_recognition) {
    try {
      _recognition.onresult = null
      _recognition.onend = null
      _recognition.onerror = null
      _recognition.onsoundstart = null
      _recognition.abort()
    } catch {}
    _recognition = null
  }
  disconnectWhisperBridge()
  if (_backend === 'deepgram' && keepDeepgramMic) {
    // Lightweight reset for chat switch — cycle the bridge session, keep mic alive.
    // This avoids the getUserMedia teardown/reacquire that causes intermittent failures.
    vlog('hardReset/dg: keeping mic, cycling session', { wsOpen: _deepgramConnected, hasMic: !!_deepgramStream })
    _deepgramInterim = ''
    _dgHasSeenInterim = false
    _dgTrickleFlush()
    _dgTrickleWords = []
    _dgTrickleShown = 0
    if (_deepgramWs && _deepgramConnected) {
      try { _deepgramWs.send(JSON.stringify({ type: 'stop' })) } catch {}
    }
  } else {
    disconnectDeepgramBridge()
  }
  _deepgramInterim = ''
  _dgHasSeenInterim = false
  _recording = false
  _state = 'edit'
  _accumulator = null
  _left = _interim = _right = ''
  _editStopped = false
  _filling = false
  _audioCaptureRetries = 0
  _lastResultTime = 0
  hideHealthDot()
  // Force the browser to drop and reacquire the microphone at the OS level.
  // Skip for whisper-stream (captures mic via SDL) and deepgram (manages its own stream).
  if (_backend !== 'whisper-stream' && _backend !== 'deepgram') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) {
        try { track.stop() } catch {}
      }
    } catch (err) {
      console.warn('voice: hard reset getUserMedia cycle failed', err)
    }
  }
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
  }

  const who = targetLabel()
  showHud(`sent → ${who}`, '#7ab8a0')
  fadeHud(2500)

  _state = 'edit'
  _left = _interim = _right = ''
  _filling = true
  ta.value = ''
  ta.style.height = 'auto'
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  _filling = false
}

// --- Key Binding ---

let _initialized = false

export async function initVoice() {
  if (_initialized) return true

  _initialized = true

  // Voice backend: URL param overrides pref. Default pref is 'chrome'.
  const urlVoice = new URLSearchParams(window.location.search).get('voice')
  const { getPref, whenPrefsLoaded } = await import('./preferences.ts')
  // Don't race the async pref load — initVoice runs at module-load time but
  // loadPrefs is triggered by the identity event. Without this wait, voice
  // would commit to the chrome default even when the user's saved pref is
  // deepgram. Cap at 2s so a never-resolving identity doesn't block voice.
  if (!urlVoice) {
    await Promise.race([whenPrefsLoaded(), new Promise(r => setTimeout(r, 2000))])
  }
  // A remote touch device is the iPad: force it onto Deepgram (reached via the
  // server proxy) because its only other option, Chrome Web Speech, is iOS
  // speech recognition — whose restart earcon is the beeping we're killing.
  // Explicit ?voice= still wins; same-machine sessions keep using the pref.
  const _preferProxyDeepgram = _isTouchDevice && !_onServerHost
  const prefBackend = urlVoice
    || (_preferProxyDeepgram ? 'deepgram' : null)
    || getPref('voice-backend') || 'chrome'
  if (prefBackend === 'chrome') {
    _backend = 'chrome'
    console.log(`voice: using Chrome Web Speech API (${urlVoice ? 'URL param' : 'pref'})`)
  } else if (prefBackend === 'whisper') {
    _backend = 'whisper-stream'
    try {
      await fetch('/api/voice/whisper/start', { method: 'POST' })
    } catch (err) {
      console.warn('voice: whisper lazy-start request failed', err)
    }
    try {
      const testWs = new WebSocket(WHISPER_BRIDGE_URL)
      testWs.onopen = () => {
        testWs.close()
        _whisperAvailable = true
        console.log('voice: using whisper-stream backend (via URL param)')
        connectWhisperBridge()
        if (_recording) showRecordingHud()
      }
      testWs.onerror = () => {
        testWs.close()
        if (!_whisperAvailable) {
          _backend = 'chrome'
          console.log('voice: whisper bridge not available, falling back to Chrome')
        }
      }
    } catch {
      _backend = 'chrome'
    }
  } else {
    // Deepgram (explicit pref or URL param)
    _backend = 'deepgram'
    try {
      await fetch('/api/voice/deepgram/start', { method: 'POST' })
    } catch (err) {
      console.warn('voice: deepgram lazy-start request failed', err)
    }
    if (!_onServerHost) {
      // iPad/remote: the bridge is reached through the same-origin server proxy,
      // which lazy-starts it. Don't probe-and-fall-back to chrome (iOS speech =
      // the beeping). Connect lazily when recording starts.
      _deepgramAvailable = true
      console.log('voice: using deepgram via server proxy (remote device)')
    } else {
      try {
        const testWs = new WebSocket(deepgramBridgeUrl())
        await new Promise((resolve, reject) => {
          testWs.onopen = () => {
            testWs.close()
            _deepgramAvailable = true
            console.log('voice: using deepgram backend (default)')
            resolve()
          }
          testWs.onerror = () => {
            testWs.close()
            reject()
          }
          setTimeout(reject, 2000)
        })
      } catch {
        _backend = 'chrome'
        console.log('voice: deepgram bridge not available, falling back to Chrome')
      }
    }
  }

  if (!SpeechRecognition && _backend === 'chrome') {
    console.warn('voice: no backend available')
    return false
  }

  // Right Shift: tap counting within 300ms windows.
  //   1 tap  → toggle recording
  //   2 taps → soft reset (kill playwright, getUserMedia cycle, restart)
  //   3 taps → kill Chrome and reopen (tlda://voice-reset)
  //
  // The handler is installed on document AND on any iframe contentDocuments
  // (via MutationObserver) so shift works regardless of where focus is.
  let _shiftTapCount = 0
  let _shiftTapTimer = null
  function shiftHandler(e) {
    if (e.code !== 'ShiftRight') return
    e.preventDefault()
    e.stopImmediatePropagation()

    _shiftTapCount++
    clearTimeout(_shiftTapTimer)

    if (_shiftTapCount >= 3) {
      // Triple tap: kill Chrome and reopen.
      // Try iframe approach to trigger tlda:// URL scheme (bypasses Chrome's
      // JS restrictions on custom protocols). Falls back to server endpoint.
      _shiftTapCount = 0
      showHud('restarting Chrome…', '#c87070')
      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      iframe.src = 'tlda://voice-reset'
      document.body.appendChild(iframe)
      setTimeout(() => iframe.remove(), 2000)
      return
    }

    // Wait 300ms to see if more taps are coming
    _shiftTapTimer = setTimeout(() => {
      const taps = _shiftTapCount
      _shiftTapCount = 0
      if (taps === 1) {
        // Single tap: toggle
        if (_recording) {
          stopRecording()
        } else {
          startRecording()
        }
      } else if (taps === 2) {
        // Double tap: soft reset (getUserMedia cycle + restart)
        showHud('voice reset', '#9370db')
        hardResetVoice().then(() => startRecording())
      }
    }, 300)
  }
  document.addEventListener('keydown', shiftHandler, true)

  // Watch for iframes and inject shift handler into their documents.
  // Without this, shift is invisible when an iframe has focus.
  const _hookedIframes = new WeakSet()
  function hookIframe(iframe) {
    if (_hookedIframes.has(iframe)) return
    _hookedIframes.add(iframe)
    const tryHook = () => {
      try {
        const doc = iframe.contentDocument
        if (doc) doc.addEventListener('keydown', shiftHandler, true)
      } catch {} // cross-origin iframes — can't hook, that's fine
    }
    tryHook()
    iframe.addEventListener('load', tryHook)
  }
  // Hook existing iframes
  for (const iframe of document.querySelectorAll('iframe')) hookIframe(iframe)
  // Hook future iframes via MutationObserver
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeName === 'IFRAME') hookIframe(node)
        if (node.querySelectorAll) {
          for (const iframe of node.querySelectorAll('iframe')) hookIframe(iframe)
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true })

  if (_micChannel) {
    _micChannel.onmessage = (e) => {
      if (e.data === 'mic-start') stopRecording()
    }
  }

  // Abort recognition before page unload to prevent WebKit crash
  // (SpeechRecognitionServer::messageSenderConnection segfault when
  // the recognition callback fires into a destroyed IPC channel)
  window.addEventListener('beforeunload', () => {
    if (_recognition) {
      try { _recognition.abort() } catch {}
      _recognition = null
    }
  })

  // Also abort when tab goes hidden — Safari suspends recognition but
  // the callback can fire during the suspension transition.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && _recognition && _recording) {
      try { _recognition.abort() } catch {}
      _recognition = null
    }
    if (!document.hidden && _recording) {
      if (_backend === 'deepgram') {
        // Resume AudioContext if suspended (tab came back from background)
        if (_deepgramContext?.state === 'suspended') {
          vlog('visibilitychange: resuming AudioContext')
          _deepgramContext.resume().catch(e => console.warn('[voice] AudioContext resume failed:', e.message))
        }
        // Ensure bridge WS is up
        if (!_deepgramConnected) {
          vlog('visibilitychange: bridge disconnected — reconnecting')
          connectDeepgramBridge()
        }
        return
      }
      // Tab became visible again — Chrome may have suspended recognition.
      // Restart it cleanly.
      const dying = _recognition
      if (dying) {
        dying.onresult = null
        dying.onend = null
        dying.onsoundstart = null
        try { dying.abort() } catch {}
      }
      _recognition = null
      if (!_recording) return
      _setupRecognition()
      try {
        _recognition.start()
      } catch (err) {
        if (err.name !== 'InvalidStateError') throw err
        setTimeout(() => { if (_recording) _recognition.start() }, 100)
      }
    }
  })

  const backend = _backend === 'deepgram' ? 'deepgram' : _backend === 'whisper-stream' ? 'whisper' : 'Web Speech API'
  console.log(`voice: initialized v8 — ${backend} — BroadcastChannel: ${!!_micChannel}`)
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
export function getTranscript() {
  if (_accumulator) return postProcessTranscript(_left + _interim)
  return _activeTextarea ? _activeTextarea.value : ''
}
export function addVocabReplacement(pattern, replacement) {
  VOCAB_REPLACEMENTS.push([pattern, replacement])
}
export function setMathMode(on) {
  _mathMode = on
  if (_recording) showRecordingHud()
}
export function isMathMode() { return _mathMode }
export function getGeneration() { return _generation }
export function getBackend() { return _backend }
export function isWhisperAvailable() { return _whisperAvailable }
export function setBackend(be) {
  if (be !== 'chrome' && be !== 'whisper-stream' && be !== 'deepgram') return
  if (be === 'whisper-stream' && !_whisperAvailable) return
  if (be === 'deepgram' && !_deepgramAvailable) return
  if (be === _backend) return
  const wasRecording = _recording
  if (wasRecording) stopRecording()
  _backend = be
  if (wasRecording) startRecording()
  showHud(`voice: ${be}`, '#9370db')
  fadeHud(2000)
}
export function resetTranscript() {
  _state = 'edit'
  _generation++
  _left = _interim = _right = ''
  _deepgramInterim = ''
  if (_backend === 'whisper-stream') flushWhisperBridge()
  if (_recording && _recognition) {
    try { _recognition.stop() } catch {}
  }
}
