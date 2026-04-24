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

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition

// --- Backend selection ---
const WHISPER_URL = 'http://127.0.0.1:8178'
let _backend = 'chrome'         // 'chrome' | 'whisper'
let _whisperAvailable = false   // true if whisper server responded at init

// --- Whisper backend state ---
let _micStream = null           // MediaStream from getUserMedia
let _mediaRecorder = null       // MediaRecorder instance
let _audioChunks = []           // accumulated audio data chunks
let _whisperAbort = null        // AbortController — cancel in-flight transcription
let _whisperLoopRunning = false // true while the sequential transcription loop is active
let _whisperPrevText = ''       // previous transcription — for prompt seeding

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
  ta.style.boxShadow = color ? `0 0 0 2px ${color}` : ''
  ta.style.transition = 'box-shadow 0.3s'
}

// Call when onresult fires — audio is flowing
function dotAudioFlowing() {
  if (!_recording) return
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
  setTextareaGlow(null)
  if (_healthDot) {
    _healthDot.style.opacity = '0'
    setTimeout(() => { if (_healthDot) _healthDot.style.display = 'none' }, 300)
  }
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
  const be = _backend === 'whisper' ? ' [whisper]' : ''
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
    hardResetVoice()
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

      // Voice-backend: "use whisper" / "use chrome" at end of text
      const backendMatch = leftTrimmed.match(/use\s+(whisper|chrome)\s*[.!,]?\s*$/i)
      if (backendMatch) {
        const newBackend = backendMatch[1].toLowerCase()
        _state = 'edit'
        _generation++
        _left = _interim = _right = ''
        if (_activeTextarea) { _filling = true; _activeTextarea.value = ''; _filling = false }
        setBackend(newBackend)
        return
      }

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
          // Accumulator send — deliver committed text to onSend callback
          _state = 'edit'
          _generation++
          _left = _interim = _right = ''
          _accumulator.onSend(cleanText)
          showHud('sent', '#7ab8a0')
          fadeHud(2500)
          // Force a fresh session — Chrome's continuous mode keeps cumulative
          // e.results; without resetting, stale finals leak into the next message.
          if (_recording && _recognition) {
            _editStopped = true
            try { _recognition.stop() } catch {}
          }
          return
        }
        if (cleanText && _activeSendTargets.length > 0 && _activeSendFn) {
          const who = targetLabel()
          const wordCount = cleanText.split(/\s+/).length
          _state = 'edit'
          _generation++
          _left = _interim = _right = ''
          _filling = true
          if (_activeTextarea) {
            _activeTextarea.value = ''
            _activeTextarea.style.height = 'auto'
          }
          _filling = false
          _activeSendFn(_activeSendTargets, cleanText)
          showHud(`sent ${wordCount} words → ${who}`, '#7ab8a0')
          fadeHud(2500)
          // Force a fresh session — Chrome's continuous mode keeps cumulative
          // e.results; without resetting, stale finals leak into the next message.
          if (_recording && _recognition) {
            _editStopped = true
            try { _recognition.stop() } catch {}
          }
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

// --- Whisper backend ---

async function whisperTranscribe(blob, signal) {
  const form = new FormData()
  form.append('file', blob, 'audio.webm')
  form.append('response_format', 'json')
  // Prompt seeding: feed last few words so Whisper maintains context
  if (_whisperPrevText) {
    const words = _whisperPrevText.split(/\s+/).slice(-8).join(' ')
    form.append('prompt', words)
  }
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
async function whisperLoop(mimeType) {
  _whisperLoopRunning = true
  const myGeneration = _generation
  while (_recording && _backend === 'whisper' && _generation === myGeneration) {
    await new Promise(r => setTimeout(r, 2000))
    if (!_recording || _audioChunks.length === 0) continue
    if (_generation !== myGeneration) break

    const ac = new AbortController()
    _whisperAbort = ac
    try {
      const blob = new Blob(_audioChunks, { type: mimeType })
      const text = await whisperTranscribe(blob, ac.signal)
      if (!_recording || ac.signal.aborted || _generation !== myGeneration) continue
      if (!text) continue

      _lastResultTime = Date.now()
      dotAudioFlowing()

      // Transition to speech state on first result
      if (_state !== 'speech') {
        _state = 'speech'
        const cursor = _activeTextarea?.selectionStart ?? (_activeTextarea?.value?.length ?? 0)
        _left = _activeTextarea?.value?.slice(0, cursor) ?? ''
        _right = _activeTextarea?.value?.slice(cursor) ?? ''
        _interim = ''
      }

      // Whisper returns full transcript of all audio so far.
      // Replace _left with the full whisper output (keeping _right from cursor).
      const cursorLeft = _activeTextarea?.value?.slice(0, _activeTextarea?.selectionStart ?? 0) ?? ''
      // If there was pre-existing text before voice started, preserve it
      const preVoice = _state === 'speech' ? '' : cursorLeft
      _left = preVoice + postProcessTranscript(text)
      _interim = ''
      _whisperPrevText = text

      // Check for voice commands in the final text
      const leftTrimmed = _left.trim()

      // Voice-backend: "use whisper" / "use chrome"
      const backendMatch = leftTrimmed.match(/use\s+(whisper|chrome)\s*[.!,]?\s*$/i)
      if (backendMatch) {
        const newBackend = backendMatch[1].toLowerCase()
        _state = 'edit'
        _generation++
        _left = _interim = _right = ''
        _whisperPrevText = ''
        _audioChunks = []
        if (_activeTextarea) { _filling = true; _activeTextarea.value = ''; _filling = false }
        setBackend(newBackend)
        break
      }

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
          _whisperPrevText = ''
          // Clear audio and restart fresh
          _audioChunks = []
          setTimeout(() => { if (_recording) showRecordingHud() }, 1600)
          break
        }
      }

      // Voice-send
      const sendMatch = leftTrimmed.match(/(send\s*it|send|sent)\s*[.!,]?\s*$/i)
      if (sendMatch) {
        const cleanText = leftTrimmed.slice(0, sendMatch.index).trim()
        if (cleanText && _accumulator && _accumulator.onSend) {
          _state = 'edit'
          _generation++
          _left = _interim = _right = ''
          _whisperPrevText = ''
          _audioChunks = []
          _accumulator.onSend(cleanText)
          showHud('sent', '#7ab8a0')
          fadeHud(2500)
          break
        }
        if (cleanText && _activeSendTargets.length > 0 && _activeSendFn) {
          const who = targetLabel()
          const wordCount = cleanText.split(/\s+/).length
          _state = 'edit'
          _generation++
          _left = _interim = _right = ''
          _whisperPrevText = ''
          _audioChunks = []
          _filling = true
          if (_activeTextarea) {
            _activeTextarea.value = ''
            _activeTextarea.style.height = 'auto'
          }
          _filling = false
          _activeSendFn(_activeSendTargets, cleanText)
          showHud(`sent ${wordCount} words → ${who}`, '#7ab8a0')
          fadeHud(2500)
          break
        }
      }

      fillTextarea(_left + _interim + _right)
    } catch (err) {
      if (err.name === 'AbortError') continue
      console.warn('voice: whisper transcription error', err)
    } finally {
      if (_whisperAbort === ac) _whisperAbort = null
    }
  }
  _whisperLoopRunning = false
  // If we broke out of the loop due to send/switch, restart the loop
  if (_recording && _backend === 'whisper') {
    whisperLoop(mimeType)
  }
}

function startWhisperRecording() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    if (!_recording) { stream.getTracks().forEach(t => t.stop()); return }
    _micStream = stream
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm'
    _mediaRecorder = new MediaRecorder(stream, { mimeType })
    _audioChunks = []
    _whisperPrevText = ''

    _mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) _audioChunks.push(e.data)
    }

    _mediaRecorder.start(1000) // ondataavailable every 1s
    whisperLoop(mimeType)
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
  _whisperPrevText = ''
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

// --- Recording ---

function startRecording() {
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

  if (_backend === 'whisper') {
    const doStart = () => {
      if (!_recording) return
      startWhisperRecording()
    }
    if (_micChannel) {
      setTimeout(doStart, 300)
    } else {
      doStart()
    }
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

  // Stop Whisper if active
  stopWhisperCleanup()

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
async function hardResetVoice() {
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
  stopWhisperCleanup()
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
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) {
      try { track.stop() } catch {}
    }
  } catch (err) {
    console.warn('voice: hard reset getUserMedia cycle failed', err)
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

  // Detect whisper server (non-blocking — never delay voice init)
  fetch(`${WHISPER_URL}/`, { method: 'GET', signal: AbortSignal.timeout(1000) })
    .then(res => {
      if (res.ok) {
        _whisperAvailable = true
        console.log('voice: whisper server available at', WHISPER_URL, '— say "use whisper" to switch')
      }
    })
    .catch(() => {})

  if (!SpeechRecognition) {
    console.warn('voice: Web Speech API not available')
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

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _recording) {
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

  const backend = _backend === 'whisper' ? 'whisper' : 'Web Speech API'
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
  if (be !== 'chrome' && be !== 'whisper') return
  if (be === 'whisper' && !_whisperAvailable) return
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
  _left = _interim = _right = ''
  if (_recording && _recognition) {
    try { _recognition.stop() } catch {}
  }
  if (_backend === 'whisper') {
    _audioChunks = []
    _whisperPrevText = ''
  }
}
