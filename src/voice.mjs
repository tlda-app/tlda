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
let _watchdogTimer = null
let _sessionTimer = null
let _sleepDetectInterval = null
let _sleepDetectLast = 0
let _deadRestarts = 0
let _gotAudioThisSession = false
let _lastResultTime = 0  // timestamp of last onresult — used for HUD health color

// Generation counter — bumped whenever _left is cleared (send, chat-switch,
// startRecording, setVoiceTarget). Each _setupRecognition() snapshots the
// current value; onresult discards callbacks from an older generation.
// Prevents stale in-flight results from writing to the textarea after a send.
let _generation = 0

// Poisoning detection — ring buffer of the last few isFinal transcript
// fragments. If the same fragment repeats POISON_THRESHOLD times in a row,
// Chrome's recognition pipeline is stuck; we clear _left and restart.
const POISON_THRESHOLD = 3
let _lastFinals = []

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

// Health dot: green at 20% when audio is flowing, amber at 40% when no audio.
// Both states are visible while recording — green = hearing you, amber = not hearing you.
// Dot is hidden when not recording.
const DOT_GREEN = '#7ab8a0'
const DOT_AMBER = '#c8956a'
const DOT_GREEN_OPACITY = '0.2'
const DOT_AMBER_OPACITY = '0.4'
const AUDIO_FLOWING_MS = 3000  // switch to amber after this long without a result
let _healthDot = null
let _healthDotTimer = null

function ensureHealthDot() {
  if (_healthDot) return _healthDot
  _healthDot = document.createElement('span')
  Object.assign(_healthDot.style, {
    display: 'none',
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    marginRight: '6px',
    flexShrink: '0',
    transition: 'opacity 0.3s, background-color 0.3s',
  })
  return _healthDot
}

// Call when onresult fires — audio is flowing
function dotAudioFlowing() {
  if (!_recording) return
  const dot = ensureHealthDot()
  dot.style.display = 'inline-block'
  dot.style.backgroundColor = DOT_GREEN
  requestAnimationFrame(() => { dot.style.opacity = DOT_GREEN_OPACITY })
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
}

// Show amber dot immediately (recording started, no audio yet)
function dotRecordingStart() {
  const dot = ensureHealthDot()
  dot.style.display = 'inline-block'
  dot.style.backgroundColor = DOT_AMBER
  requestAnimationFrame(() => { dot.style.opacity = DOT_AMBER_OPACITY })
}

function hideHealthDot() {
  clearTimeout(_healthDotTimer)
  _healthDotTimer = null
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
  const text = who ? `recording → ${who}${mode}` : `recording${mode}`
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
  _lastFinals = []
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
    _lastFinals = []
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

  _recognition.onsoundstart = () => {
    _gotAudioThisSession = true
    _deadRestarts = 0
    clearTimeout(_watchdogTimer)
    _watchdogTimer = setTimeout(watchdogRestart, 8000)
  }

  _recognition.onresult = (e) => {
    // Discard results from a stale session (generation bumped since setup).
    if (_generation !== myGeneration) return

    _gotAudioThisSession = true
    _deadRestarts = 0
    _lastResultTime = Date.now()
    dotAudioFlowing()
    clearTimeout(_watchdogTimer)
    _watchdogTimer = setTimeout(watchdogRestart, 8000)

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
        const fragment = e.results[i][0].transcript
        _left += fragment

        // Poisoning detection: if Chrome keeps returning the same final
        // fragment POISON_THRESHOLD times in a row, the recognition pipeline
        // is stuck. Clear accumulated text and restart with a fresh session.
        _lastFinals.push(fragment)
        if (_lastFinals.length > POISON_THRESHOLD) _lastFinals.shift()
        if (
          _lastFinals.length === POISON_THRESHOLD &&
          _lastFinals.every(f => f === fragment)
        ) {
          console.warn('voice: poisoning detected — restarting recognition')
          _generation++
          _lastFinals = []
          _left = _interim = _right = ''
          if (_activeTextarea) {
            _filling = true
            _activeTextarea.value = ''
            _activeTextarea.style.height = 'auto'
            _activeTextarea.dispatchEvent(new Event('input', { bubbles: true }))
            _filling = false
          }
          showHud('voice reset — recognition was stuck', '#c8956a')
          fadeHud(3000)
          watchdogRestart()
          return
        }
      } else {
        interim += e.results[i][0].transcript
      }
    }
    _interim = interim

    const voiceText = (_left + interim).trim()
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
          _lastFinals = []
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
        if (cleanText && _activeSendTargets.length > 0 && _activeSendFn) {
          const who = targetLabel()
          const wordCount = cleanText.split(/\s+/).length
          _state = 'edit'
          _generation++
          _lastFinals = []
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
          // Force a fresh SpeechRecognition session after send.
          // Chrome's continuous mode keeps cumulative e.results; without
          // resetting, stale finals can leak into the next message's _left.
          if (_recording && _recognition) {
            _editStopped = true
            try { _recognition.stop() } catch {}
          }
          setTimeout(() => {
            if (_recording) showRecordingHud()
          }, 2600)
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

function watchdogRestart() {
  if (!_recording) return
  // No give-up state — always retry. The health dot shows amber when
  // audio isn't flowing; the user sees that and can double-shift if needed.
  _gotAudioThisSession = false
  // Preserve text: commit interim to left, freeze current state
  if (_state === 'speech') {
    _left += _interim
    _interim = ''
  }
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
  if (!_recording) return
  // Keep _state, _left, _right as-is — resume from where we were
  _interim = ''
  _lastFinals = []
  _setupRecognition()
  try {
    _recognition.start()
  } catch (err) {
    if (err.name !== 'InvalidStateError') throw err
    setTimeout(() => { if (_recording) _recognition.start() }, 100)
  }
  _watchdogTimer = setTimeout(watchdogRestart, 8000)
  _sessionTimer = setTimeout(sessionRestart, 45000)
}

function sessionRestart() {
  if (!_isChrome) return
  if (!_recording) return
  if (!_recognition) return
  if (_state === 'speech') {
    _left += _interim
    _interim = ''
  }
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
  if (!_recording) return
  _interim = ''
  _lastFinals = []
  _setupRecognition()
  try {
    _recognition.start()
  } catch (err) {
    if (err.name !== 'InvalidStateError') throw err
    setTimeout(() => { if (_recording) _recognition.start() }, 100)
  }
  _watchdogTimer = setTimeout(watchdogRestart, 8000)
  _sessionTimer = setTimeout(sessionRestart, 45000)
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
    if (!_recording) return
    _sleepDetectLast = Date.now()
    _setupRecognition()
    try {
      _recognition.start()
    } catch (err) {
      if (err.name !== 'InvalidStateError') throw err
      setTimeout(() => { if (_recording) _recognition.start() }, 100)
    }
    _watchdogTimer = setTimeout(watchdogRestart, 8000)
    _sessionTimer = setTimeout(sessionRestart, 45000)
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
  _state = 'edit'
  _generation++
  _lastFinals = []
  _left = _interim = _right = ''
  _lastResultTime = 0

  showRecordingHud()
  dotRecordingStart()

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
  hideHealthDot()

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

// Hard reset — the escape hatch for when Chrome's SpeechRecognition
// pipeline is poisoned and normal stop/start won't un-stick it. Triggered
// by double-tap on Right Shift. Aborts any live recognition, clears all
// timers and state, and releases the browser's microphone lock by opening
// and immediately closing a getUserMedia audio stream. After this fires,
// the next single-tap of Right Shift should start a fresh clean session.
async function hardResetVoice() {
  // Tear down recognition — abort (not stop) to force an immediate release
  // without waiting for a clean onend from any in-flight audio.
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
  // Clear every timer.
  clearTimeout(_watchdogTimer); _watchdogTimer = null
  clearTimeout(_sessionTimer); _sessionTimer = null
  clearInterval(_sleepDetectInterval); _sleepDetectInterval = null
  // Reset every bit of state the speech state machine cares about.
  _recording = false
  _state = 'edit'
  _left = _interim = _right = ''
  _editStopped = false
  _filling = false
  _audioCaptureRetries = 0
  _deadRestarts = 0
  _gotAudioThisSession = false
  _lastResultTime = 0
  _sleepDetectLast = 0
  hideHealthDot()
  // Force the browser to drop and reacquire the microphone at the OS level.
  // SpeechRecognition uses the same underlying audio plumbing as
  // getUserMedia, so cycling a mic stream here jogs the internal state.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) {
      try { track.stop() } catch {}
    }
  } catch (err) {
    console.warn('voice: hard reset getUserMedia cycle failed', err)
  }
  showHud('voice reset — tap shift to start', '#9370db')
  fadeHud(3000)
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

  if (!SpeechRecognition) {
    console.warn('voice: Web Speech API not available')
    return false
  }

  // Right Shift: single tap = toggle recording. Double tap (within 300ms)
  // = hard voice reset — recovery pathway for when Chrome's SpeechRecognition
  // pipeline gets poisoned and normal stop/start doesn't un-stick it.
  let _lastShiftTapAt = 0
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'ShiftRight') return
    e.preventDefault()
    e.stopImmediatePropagation()

    const now = Date.now()
    if (now - _lastShiftTapAt < 300) {
      // Double tap: hard reset
      _lastShiftTapAt = 0
      hardResetVoice()
      return
    }
    _lastShiftTapAt = now

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
      if (!_recording) return
      _setupRecognition()
      try {
        _recognition.start()
      } catch (err) {
        if (err.name !== 'InvalidStateError') throw err
        setTimeout(() => { if (_recording) _recognition.start() }, 100)
      }
      _watchdogTimer = setTimeout(watchdogRestart, 8000)
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
  if (_recording) showRecordingHud()
}
export function isMathMode() { return _mathMode }
export function getGeneration() { return _generation }
export function resetTranscript() {
  _state = 'edit'
  _left = _interim = _right = ''
  if (_recording && _recognition) {
    try { _recognition.stop() } catch {}
  }
}
