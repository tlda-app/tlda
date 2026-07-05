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
//   setVoiceTarget(textarea, targetHandle)

import { appendToken } from './authToken.ts'
import { log } from './logger.ts'
import { getPref, subscribePref, whenPrefsLoaded } from './preferences.ts'

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const _isSafari = !navigator.userAgent.includes('Chrome') && navigator.userAgent.includes('Safari')
// Touch-device test = has a touchscreen. Must use maxTouchPoints, NOT
// matchMedia('(pointer: coarse)'): with a Magic Keyboard / trackpad attached the
// iPad's *primary* pointer is "fine", so (pointer: coarse) is false and the iPad
// would wrongly fall back to iOS speech (the beeping). maxTouchPoints stays true
// on any iPad and is 0 on the Mac.
const _isTouchDevice = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
// iOS = iPhone/iPad/iPod (incl. iPadOS pretending to be a Mac). EVERY iOS browser
// runs on WebKit (Apple's App Store rule), so Chrome/Firefox-on-iOS are WKWebView.
// Web Speech availability varies across iOS/WebKit builds and can fail at
// SpeechRecognition.start() with 'service-not-allowed'. Before treating that as
// a hard recognizer failure, run one explicit mic-permission probe and retry.
const _isIOS = typeof navigator !== 'undefined' && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
)

// User-facing message for Web Speech 'service-not-allowed'. Keep it plain:
// this is a hard recognizer failure, and extra browser/backend advice has been
// more confusing than useful on phone.
function serviceUnavailableMessage(isIOS) {
  return isIOS
    ? 'Browser voice refused by iPhone browser'
    : 'Browser voice service refused'
}

// --- Backend selection ---
const WHISPER_BRIDGE_URL = location.protocol === 'https:' ? 'wss://127.0.0.1:8179' : 'ws://127.0.0.1:8179'

// Deepgram bridge URL. On the server's own machine we reach the bridge directly
// at 127.0.0.1:8179. From another device (the iPad over Tailscale/LAN) localhost
// is the iPad itself — no bridge there — so relay through a same-origin WS proxy
// on the tlda server (/voice/deepgram), reusing the page's TLS + token. This is
// what keeps the iPad off iOS Web Speech, whose restart earcon causes the beeping.
const _onServerHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname)
// Deepgram is SDK-only — one implementation (Skip, 6/19: "we're going with the
// SDK implementation, it is better"). The bridge is bin/deepgram-sdk-bridge.mjs
// on port 8180; a device that can't reach 127.0.0.1 (the iPad) relays through the
// same-origin /voice/deepgram-sdk WS proxy on the tlda server.
function deepgramBridgeUrl() {
  if (_onServerHost) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://127.0.0.1:8180`
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return appendToken(`${proto}://${location.host}/voice/deepgram-sdk`)
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
const VOICE_HUD_WIDTH = '240px'
const RADIO_HUD_EXPANDED_MS = 4500
const RADIO_HUD_MAX_CHARS = 180

// Recording on/off listeners — lets the viewer react when recording starts/stops
// (e.g. to re-aim the dictation target at the currently-selected note).
const _recordingListeners = new Set()
function emitRecordingChange() { for (const cb of _recordingListeners) { try { cb(_recording) } catch {} } }
export function onRecordingChange(cb) { _recordingListeners.add(cb); return () => { _recordingListeners.delete(cb) } }
const _targetListeners = new Set()
function emitVoiceTargetChange() { for (const cb of _targetListeners) { try { cb() } catch {} } }
export function onVoiceTargetChange(cb) { _targetListeners.add(cb); return () => { _targetListeners.delete(cb) } }
export function isVoiceDumping() { return _voiceDumping }

// Voice tap dispatcher — the single source of truth for the Right-Shift gesture,
// shared by the keydown handler AND the on-screen mic button so they behave
// identically: 1 tap = toggle recording, 2 taps = soft reset (mic cycle +
// restart), 3 taps = kill Chrome and reopen. Tap counting uses a 300ms window.
let _voiceTapCount = 0
let _voiceTapTimer = null
export function voiceTap() {
  _voiceTapCount++
  clearTimeout(_voiceTapTimer)
  if (_voiceTapCount >= 3) {
    // Triple tap: kill Chrome and reopen via the tlda:// URL scheme (an iframe
    // bypasses Chrome's JS restrictions on custom protocols).
    _voiceTapCount = 0
    showHud('restarting Chrome…', '#c87070')
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    iframe.src = 'tlda://voice-reset'
    document.body.appendChild(iframe)
    setTimeout(() => iframe.remove(), 2000)
    return
  }
  _voiceTapTimer = setTimeout(() => {
    const taps = _voiceTapCount
    _voiceTapCount = 0
    if (taps === 1) {
      if (_recording) { stopRecording() } else { startRecording() }
    } else if (taps === 2) {
      showHud('voice reset', '#9370db')
      hardResetVoice().then(() => startRecording())
    }
  }, 300)
}

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
let _serviceUnavailableRetries = 0
let _lastResultTime = 0  // timestamp of last onresult — used for HUD health color
let _recordStartTime = 0   // Date.now() at record start — for time-to-first-interim instrumentation
let _firstInterimLogged = false
let _lastChromeMissingnessMarker = ''
let _chromeUnexpectedRestartFailures = 0
const CHROME_UNEXPECTED_RESTART_LIMIT = 5
const CHROME_MIN_MISSINGNESS_MARKER_MS = 100

// Generation counter — bumped whenever _left is cleared (send, chat-switch,
// startRecording, setVoiceTarget). Each _setupRecognition() snapshots the
// current value; onresult discards callbacks from an older generation.
// Prevents stale in-flight results from writing to the textarea after a send.
let _generation = 0

// Active chat target
let _activeTextarea = null
let _activeTargetHandle = null
let _voiceDumping = false
// The real field voice was routed to just before going to <nowhere>, captured so
// the sink's second click can wipe its in-flight interim (left+right kept).
let _sinkPrevTextarea = null
let _sinkPrevAccumulator = null
let _sinkPrevLeft = ''
let _sinkPrevRight = ''

// Accumulator target — alternative to _activeTextarea for code editors etc.
// When set, fillTextarea() calls onUpdate instead of writing to a DOM element.
// { onUpdate(text), onSend(text)|null, onStop()|null, label } | null
let _accumulator = null

const DOUBLE_TAP_MS = 350

const _micChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fleet-voice-mic') : null

// --- HUD ---

let _radioSubtitle = null
let _radioExpanded = false
let _radioCollapseTimer = null

function cleanRadioSubtitleText(text) {
  const cleaned = String(text || '')
    .replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-args|local-command-stdout)>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\bhttps?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([:;,.!?])/g, '$1')
    .trim()
  if (cleaned.length <= RADIO_HUD_MAX_CHARS) return cleaned
  const prefix = cleaned.slice(0, RADIO_HUD_MAX_CHARS - 3).replace(/\s+\S*$/, '')
  return `${prefix || cleaned.slice(0, RADIO_HUD_MAX_CHARS - 3)}...`
}

function labelForRadioAgent(agentId, agents = []) {
  const agent = agents.find(a => a.id === agentId || a.friendly_name === agentId)
  return agent?.friendly_name || agent?.name || String(agentId || '').replace(/^fleet:/, '') || 'agent'
}

function activeRadioTargetLabels() {
  const labels = new Set()
  const targets = activeSendTargets()
  const names = activeAgentNames()
  for (const target of targets) {
    if (!target) continue
    labels.add(String(target).toLowerCase())
    const display = names[target]
    if (display) labels.add(String(display).toLowerCase())
  }
  return labels
}

function radioAgentMatchesActiveTarget(agentId, agents = []) {
  if (!agentId) return false
  const labels = activeRadioTargetLabels()
  if (labels.size === 0) return false
  const agent = agents.find(a => a.id === agentId || a.friendly_name === agentId)
  const candidates = [
    agentId,
    String(agentId).replace(/^fleet:/, ''),
    agent?.id,
    agent?.friendly_name,
    agent?.name,
    agent?.pretty_name,
  ]
  return candidates.some(v => v && labels.has(String(v).toLowerCase()))
}

function isPhoneDocSurface() {
  if (typeof document === 'undefined') return false
  if (!document.body?.classList?.contains('phone-mode')) return false
  try {
    return new URLSearchParams(window.location.search).has('doc')
  } catch {
    return false
  }
}

function collapseRadioSubtitle() {
  _radioExpanded = false
  if (_recording) showRecordingHud()
  else if (_callState) showHud('', '#7ab8a0')
  else hideHud()
}

function showRadioSubtitle(event, agents = []) {
  const text = cleanRadioSubtitleText(event?.text)
  if (!text) return false
  const from = event.from || event.agent || ''
  _radioSubtitle = {
    from,
    label: labelForRadioAgent(from, agents),
    text,
    timestamp: event.timestamp || new Date().toISOString(),
  }
  _radioExpanded = true
  clearTimeout(_radioCollapseTimer)
  showHud(`radio <- ${_radioSubtitle.label}`, '#7ab8a0')
  _radioCollapseTimer = setTimeout(collapseRadioSubtitle, RADIO_HUD_EXPANDED_MS)
  return true
}

export function maybeShowRadioSubtitleForIncomingChat(event, agents = [], humanId = null) {
  if (!isPhoneDocSurface()) return false
  if (!event || event.type !== 'chat') return false
  if (!humanId || event.to !== humanId) return false
  if (!event.from || event.from === humanId) return false
  if (!radioAgentMatchesActiveTarget(event.from, agents)) return false
  return showRadioSubtitle(event, agents)
}

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
    width: VOICE_HUD_WIDTH,
    maxWidth: 'calc(100vw - 40px)',
    boxSizing: 'border-box',
    justifyContent: 'center',
    overflow: 'hidden',
  })
  document.body.appendChild(_hud)
  positionHud(_hud)
  return _hud
}

function positionHud(hud) {
  const phone = document.body?.classList?.contains('phone-mode')
  hud.style.top = phone ? '12px' : ''
  hud.style.bottom = phone ? '' : '20px'
}

// Health dot: green at 20% when audio is flowing, amber at 40% when no audio.
// Both states are visible while recording — green = hearing you, amber = not hearing you.
// Dot is hidden when not recording.
const DOT_GREEN = '#7ab8a0'
const DOT_AMBER = '#c8956a'
const DOT_GREEN_OPACITY = '0.4'
const DOT_AMBER_OPACITY = '0.4'
const AUDIO_FLOWING_MS = 3000  // switch to amber after this long without a result
const MIC_INPUT_TIMEOUT_MS = 1500  // no raw mic frame for this long → honest "no mic input"
const VOICE_LIVENESS_INTERVAL_MS = 1000
const CHROME_DEAD_RESULT_TIMEOUT_MS = 30000
const WHISPER_INPUT_TIMEOUT_MS = 10000

// Honest mic status from RAW frame arrival (not Deepgram results), so a
// silently-dead/muted mic reads as "no mic input" instead of a fake "mic live".
// Pure → unit-tested. `micAgo` = ms since the last worklet frame (null = none yet).
function micPresence(micAgo, ctxState, timeoutMs = MIC_INPUT_TIMEOUT_MS) {
  if (ctxState === 'closed') return 'no-input'
  if (micAgo == null || micAgo > timeoutMs) return 'no-input'
  return 'live'
}

// Chrome Web Speech can be legitimately silent for a long time. Treat silence
// as live while a recognition object is active; report death only when the
// session is no longer active and either never produced results or has been
// resultless for a long window.
function chromeLiveness(resultAgo, hasActiveSession, editStopped, deadTimeoutMs = CHROME_DEAD_RESULT_TIMEOUT_MS) {
  if (hasActiveSession) return 'live'
  if (editStopped) return 'live'
  if (resultAgo == null || resultAgo > deadTimeoutMs) return 'dead'
  return 'live'
}

function whisperLiveness(messageAgo, wsReadyState, connected, timeoutMs = WHISPER_INPUT_TIMEOUT_MS) {
  if (!connected || wsReadyState == null || wsReadyState > 1) return 'dead'
  if (messageAgo == null || messageAgo > timeoutMs) return 'no-input'
  return 'live'
}

function shouldAutoStartOnInit() {
  // initVoice() should only install controls and select the saved backend. Starting
  // capture on page load creates hidden prompts, Web Speech gesture failures, and
  // confusing retry/status churn on phone.
  return false
}

let _healthDot = null
let _healthDotTimer = null
let _voiceHealthLabel = ''
let _voiceLivenessInterval = null
let _lastWhisperMessageTime = 0

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
  _voiceHealthLabel = 'speech detected'
  showRecordingHud()
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
  _voiceHealthLabel = liveLivenessLabel()
  showRecordingHud()
  const dot = ensureHealthDot()
  dot.style.backgroundColor = DOT_AMBER
  dot.style.opacity = DOT_AMBER_OPACITY
  setTextareaGlow(GLOW_AMBER)
}

// Show amber dot immediately (recording started, no audio yet)
function dotRecordingStart() {
  _voiceHealthLabel = 'starting voice'
  const dot = ensureHealthDot()
  dot.style.display = 'inline-block'
  dot.style.backgroundColor = DOT_AMBER
  requestAnimationFrame(() => { dot.style.opacity = DOT_AMBER_OPACITY })
  setTextareaGlow(GLOW_AMBER)
}

function showVoiceLiveness(status, liveLabel) {
  if (status === 'live') {
    if (_voiceHealthLabel === 'no mic input' || _voiceHealthLabel === 'connection lost') {
      _voiceHealthLabel = liveLabel
      showRecordingHud()
    }
    return
  }

  const nextLabel = status === 'dead' ? 'connection lost' : 'no mic input'
  if (_voiceHealthLabel === nextLabel) return
  _voiceHealthLabel = nextLabel
  const dot = ensureHealthDot()
  dot.style.display = 'inline-block'
  dot.style.backgroundColor = DOT_AMBER
  dot.style.opacity = DOT_AMBER_OPACITY
  setTextareaGlow(GLOW_AMBER)
  showRecordingHud()
}

function voiceLivenessStatus(now = Date.now()) {
  if (_backend === 'deepgram') {
    const micAgo = _lastMicFrameTime ? now - _lastMicFrameTime : null
    return micPresence(micAgo, _deepgramContext?.state)
  }
  if (_backend === 'chrome') {
    const resultAgo = _lastResultTime ? now - _lastResultTime : null
    return chromeLiveness(resultAgo, !!_recognition, _editStopped)
  }
  if (_backend === 'whisper-stream') {
    const messageAgo = _lastWhisperMessageTime ? now - _lastWhisperMessageTime : null
    return whisperLiveness(messageAgo, _whisperWs?.readyState, _whisperConnected)
  }
  return 'live'
}

function liveLivenessLabel() {
  if (_backend === 'deepgram') return _deepgramConnected ? 'mic live; waiting for speech' : 'waiting for recognizer'
  if (_backend === 'whisper-stream') return 'mic live; waiting for speech'
  return 'mic live'
}

function runVoiceLivenessWatchdog() {
  if (!_recording) return
  showVoiceLiveness(voiceLivenessStatus(), liveLivenessLabel())
}

function startVoiceLivenessWatchdog() {
  clearInterval(_voiceLivenessInterval)
  _voiceLivenessInterval = setInterval(runVoiceLivenessWatchdog, VOICE_LIVENESS_INTERVAL_MS)
}

function stopVoiceLivenessWatchdog() {
  clearInterval(_voiceLivenessInterval)
  _voiceLivenessInterval = null
}

function showVoiceRestarting(reason = 'recognition restart') {
  if (!_recording) return
  _voiceHealthLabel = 'restarting voice'
  log.info('voice', 'restarting', { backend: _backend, reason, hostname: location.hostname })
  showRecordingHud()
}

function markVoiceRestarted() {
  setTimeout(() => {
    if (!_recording || _voiceHealthLabel !== 'restarting voice') return
    _voiceHealthLabel = liveLivenessLabel()
    showRecordingHud()
  }, 700)
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
  _voiceHealthLabel = ''
  setTextareaGlow(null)
  if (_healthDot) {
    _healthDot.style.opacity = '0'
    setTimeout(() => { if (_healthDot) _healthDot.style.display = 'none' }, 300)
  }
}

// --- Voice reconnect notice ---
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
  _dontSpeakOverlay.textContent = 'Pause — voice is reconnecting'
  document.body.appendChild(_dontSpeakOverlay)
  return _dontSpeakOverlay
}

function showDontSpeak(reason = 'voice is reconnecting') {
  if (!_recording) return
  _voiceHealthLabel = reason
  showRecordingHud()
}

function hideDontSpeak() {
  if (_dontSpeakOverlay) _dontSpeakOverlay.style.display = 'none'
}

// The `start` message carries the user-tunable conservation params (Preferences →
// fleet_prefs) so Skip can adjust the feel from the panel without a rebuild; the
// bridge applies them per-connection (falling back to its own defaults).
function dgStartMsg() {
  return JSON.stringify({
    type: 'start',
    idleMs: getPref('voice-idle-cutoff-ms'),
    prerollMs: getPref('voice-preroll-ms'),
    resumeRms: getPref('voice-resume-rms'),
    // Deepgram recognition-window params (applied via the bridge's voiceParams hook).
    endpointing: getPref('voice-endpointing'),
    utterance_end_ms: getPref('voice-utterance-end-ms'),
  })
}

// Tell the bridge to drop/restore the upstream Deepgram session as routing and
// tab visibility change, so we stream only while actively dictating in the active
// tab (Skip's principle). The mic stays live throughout — only the upstream
// routing toggles, so resume is instant.
function reconcileUpstream() {
  if (!_deepgramWs || _deepgramWs.readyState !== WebSocket.OPEN || !_deepgramConnected || _backend !== 'deepgram') return
  const action = upstreamAction({
    recording: _recording,
    routed: voiceHasRoute(),
    tabHidden: typeof document !== 'undefined' && document.hidden,
    paused: _dgUpstreamPaused,
  })
  if (action === 'pause') {
    try { _deepgramWs.send(JSON.stringify({ type: 'stop' })) } catch { /* WS race; reconcile retries next tick */ }
    _dgUpstreamPaused = true
    vlog('upstream paused (routed-to-nowhere or tab backgrounded)')
  } else if (action === 'resume') {
    try { _deepgramWs.send(dgStartMsg()) } catch { /* WS race; reconcile retries next tick */ }
    _dgUpstreamPaused = false
    vlog('upstream resumed (routed + foreground)')
  }
}

function sendDeepgramAudioChunk(data) {
  if (!_deepgramWs || !_deepgramConnected || !_recording) return false
  reconcileUpstream()
  if (_dgUpstreamPaused) return false   // routed-to-nowhere / backgrounded — don't stream (don't bill)
  try {
    _deepgramWs.send(data)
  } catch (err) {
    console.warn('voice: deepgram audio send failed', err)
    return false
  }
  _lastAudioChunkTime = Date.now()
  hideDontSpeak()
  if (_voiceHealthLabel === 'starting voice' || _voiceHealthLabel === 'connecting to recognizer' || _voiceHealthLabel === 'recognizer connected') {
    _voiceHealthLabel = 'mic live; waiting for speech'
    showRecordingHud()
  }
  return true
}

function finalizeDeepgramBridge() {
  if (!_deepgramWs || !_deepgramConnected) return
  try { _deepgramWs.send(JSON.stringify({ type: 'finalize' })) } catch {}
}

function showHud(text, stateColor) {
  const hud = ensureHud()
  positionHud(hud)
  clearTimeout(_fadeTimer)
  // Build HUD content with health dot + text. Radio subtitle, when active, is
  // a second line in the same quiet plaque rather than a separate chat panel.
  const dot = ensureHealthDot()
  hud.textContent = ''
  hud.style.display = 'flex'
  hud.style.alignItems = _radioExpanded && _radioSubtitle ? 'stretch' : 'center'
  hud.style.flexDirection = 'column'
  const statusRow = document.createElement('div')
  Object.assign(statusRow.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '0',
    overflow: 'hidden',
    width: '100%',
  })
  statusRow.appendChild(dot)
  const span = document.createElement('span')
  span.textContent = text
  Object.assign(span.style, {
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  })
  statusRow.appendChild(span)
  appendCallSegment(statusRow)
  hud.appendChild(statusRow)
  if (_radioExpanded && _radioSubtitle) {
    const line = document.createElement('div')
    line.textContent = _radioSubtitle.text
    Object.assign(line.style, {
      marginTop: '2px',
      minWidth: '0',
      overflow: 'hidden',
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: '2',
      whiteSpace: 'normal',
      wordBreak: 'break-word',
      color: 'rgba(255,255,255,0.82)',
      fontSize: '11px',
      lineHeight: '1.25',
      textAlign: 'center',
      width: '100%',
    })
    hud.appendChild(line)
  }
  hud.style.color = activeAgentColor() || stateColor || 'rgba(255,255,255,0.7)'
  requestAnimationFrame(() => { hud.style.opacity = '1' })
}

function speechContext(extra = {}) {
  let standalone = false
  try {
    standalone = !!navigator.standalone || !!window.matchMedia?.('(display-mode: standalone)').matches
  } catch {
    // Best effort: browser standalone probes can be unavailable during tests.
  }
  let topLevel = true
  try { topLevel = window.top === window.self } catch { topLevel = false }
  return {
    backend: _backend,
    isIOS: _isIOS,
    isSafari: _isSafari,
    isTouch: _isTouchDevice,
    hasSpeechRecognition: !!SpeechRecognition,
    hasMediaDevices: !!navigator.mediaDevices?.getUserMedia,
    isSecureContext: typeof window !== 'undefined' ? !!window.isSecureContext : null,
    standalone,
    topLevel,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : null,
    userActivationActive: navigator.userActivation?.isActive ?? null,
    userActivationSeen: navigator.userActivation?.hasBeenActive ?? null,
    hostname: location.hostname,
    protocol: location.protocol,
    ...extra,
  }
}

async function logSpeechContext(stage, extra = {}) {
  const data = speechContext(extra)
  try {
    const permissions = navigator.permissions
    if (permissions?.query) {
      const status = await permissions.query({ name: 'microphone' })
      data.microphonePermission = status?.state || null
    }
  } catch (err) {
    data.microphonePermission = 'query-failed'
    data.microphonePermissionError = err?.name || String(err)
  }
  log.metric('voice', stage, data)
  return data
}

// --- Live voice/video call status (folded into the speech HUD) ---
// The LiveKit live-room controller reports call mic state here so it shows in
// the same HUD as dictation, rather than as a separate floating indicator.
// `_callState` = { inCall, micOn, participantCount } | null.
let _callState = null
const CALL_MIC_LIVE = '#7ab8a0'   // mic open in the call (matches DOT_GREEN)
const CALL_MIC_MUTED = '#c8956a'  // muted (matches DOT_AMBER)

function appendCallSegment(hud) {
  if (!_callState || !_callState.inCall) return
  const sep = document.createElement('span')
  sep.textContent = '·'
  Object.assign(sep.style, { margin: '0 6px', opacity: '0.4' })
  hud.appendChild(sep)
  const dot = document.createElement('span')
  Object.assign(dot.style, {
    display: 'inline-block',
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    marginRight: '5px',
    backgroundColor: _callState.micOn ? CALL_MIC_LIVE : CALL_MIC_MUTED,
    opacity: '0.7',
  })
  hud.appendChild(dot)
  const label = document.createElement('span')
  const count = _callState.participantCount > 1 ? ` (${_callState.participantCount})` : ''
  label.textContent = `${_callState.micOn ? 'call' : 'call muted'}${count}`
  label.style.opacity = '0.7'
  hud.appendChild(label)
}

// Called by the live-room controller. Pass null when leaving the call.
export function setCallMicState(state) {
  _callState = state && state.inCall ? state : null
  if (_recording) {
    // Dictation HUD is already visible; re-render it to include the call segment.
    showRecordingHud()
  } else if (_callState) {
    // Not dictating but in a call — show the HUD with just the call segment.
    showHud('', '#7ab8a0')
  } else {
    hideHud()
  }
}

// Show recording status — text uses agent color, dot shows health separately
function voiceStatusLabel() {
  const label = _voiceHealthLabel || ''
  if (label.startsWith('mic stalled') || label.startsWith('mic stopped') || label.startsWith('connection lost')) return 'reconnecting'
  if (label.includes('reconnecting') || label.includes('restarting')) return 'reconnecting'
  if (label === 'no mic input') return 'reconnecting'
  if (label === 'speech detected') return 'speaking'
  if (label === 'restarting voice') return 'reconnecting'
  if (label === 'starting voice' || label === 'connecting to recognizer') return 'reconnecting'
  if (label === 'recognizer connected') return 'mic live'
  if (label.startsWith('mic live') || label === 'waiting for recognizer') return 'mic live'
  return label || 'mic live'
}

function showRecordingHud() {
  const who = targetLabel() || 'nowhere'
  const mode = _mathMode ? ' [math]' : ''
  const text = `${voiceStatusLabel()} -> ${who}${mode}`
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
    resetDeepgramTextState()
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

function activeSendTargets() {
  return _activeTargetHandle?.getSendTargets?.() || []
}

function activeAgentNames() {
  return _activeTargetHandle?.getAgentNames?.() || {}
}

function activeAgentColor() {
  return _activeTargetHandle?.getAgentColor?.() || null
}

export function setVoiceTarget(textarea, targetHandle) {
  let wasRecording = false
  _voiceDumping = false
  if (textarea !== _activeTextarea) {
    // Hard reset voice on chat switch — same as double-shift-right.
    // Without this, the old recognition session keeps running with a stale
    // generation and onresult discards everything, making voice appear dead.
    wasRecording = _recording
    vlog('setVoiceTarget: switching chat', { wasRecording, backend: _backend, wsOpen: _deepgramConnected, hasMic: !!_deepgramStream })
    if (_backend === 'whisper-stream') flushWhisperBridge()
    if (_backend === 'deepgram') resetDeepgramTextState()
    hardResetVoice({ keepDeepgramMic: true })
    _recording = false
    // Remove old listeners
    if (_inputListeners && _activeTextarea) {
      _activeTextarea.removeEventListener('input', _inputListeners.input)
      _activeTextarea.removeEventListener('click', _inputListeners.click)
      _activeTextarea.removeEventListener('keydown', _inputListeners.keydown)
      _inputListeners = null
    }
    _state = 'edit'
    _generation++
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
  _activeTargetHandle = targetHandle || null
  // Prime the always-present transparent ring so the first record-start is a
  // colour-only transition, not a 0→2px geometry pop (see setTextareaGlow).
  if (textarea && !textarea.style.boxShadow) textarea.style.boxShadow = '0 0 0 2px transparent'
  // If voice was recording before the chat switch, restart it on the new target
  if (wasRecording && textarea) {
    startRecording()
  } else if (_recording) {
    showRecordingHud()
  }
  emitVoiceTargetChange()
}

export function clearVoiceTarget(textarea) {
  if (_activeTextarea === textarea) {
    _voiceDumping = false
    _activeTextarea = null
    _activeTargetHandle = null
    // Keep recording; just refresh the HUD to the targetless label.
    if (_recording) showRecordingHud()
    emitVoiceTargetChange()
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
  _voiceDumping = false
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
  emitVoiceTargetChange()
}

export function clearVoiceAccumulator(onUpdate) {
  if (_accumulator && _accumulator.onUpdate === onUpdate) {
    _voiceDumping = false
    _accumulator = null
    // Deselecting a note clears the target but never stops the recorder —
    // mirrors clearVoiceTarget. The stream is simply discarded (fillTextarea
    // returns early with no accumulator/textarea) until a new target is set.
    // Only the mic button stops recording. Refresh the HUD so it drops the
    // stale "→ note" label and shows the targetless "recording" state.
    if (_recording) showRecordingHud()
    emitVoiceTargetChange()
  }
}

// Called when the cursor is moved by the user while an accumulator is active.
// Mirrors enterEdit() — interrupts the current speech session so the next
// session will snapshot the new cursor position on first result.
export function notifyAccumulatorCursorMoved() {
  if (!_accumulator) return
  enterEdit()
}

export function dumpVoiceTarget() {
  enterVoiceSink()
}

// True when voice is routed to a real destination (a textarea, an accumulator,
// or chat send-targets) and NOT dumping to nowhere. Streaming to Deepgram is
// gated on this so "recording to nowhere" / dumb mode never bills.
function voiceHasRoute() {
  return !_voiceDumping && (!!_activeTextarea || !!_accumulator || activeSendTargets().length > 0)
}

// Pure decision for the upstream lifecycle (unit-tested). `paused` = we've already
// told the bridge to stop. Returns the action to take this tick.
//   'resume' → send {start}, stream      'pause' → send {stop}, stop streaming
//   'send'   → stream (already active)    'hold'  → stay paused, don't stream
export function upstreamAction({ recording, routed, tabHidden, paused }) {
  const want = recording && routed && !tabHidden
  if (want) return paused ? 'resume' : 'send'
  return paused ? 'hold' : 'pause'
}

function targetLabel() {
  if (_voiceDumping) return '<nowhere>'
  if (_accumulator) return _accumulator.label || 'note'
  const targets = activeSendTargets()
  const names = activeAgentNames()
  if (targets.length === 0) return null
  return targets
    .map(id => names[id] || id.replace('fleet:', ''))
    .join(', ')
}

function parseCsvPref(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function interactiveSinkChild(target) {
  if (!target || !target.closest) return false
  return !!target.closest('button, input, textarea, select, option, a, [role="button"], [contenteditable="true"], .cm-editor')
}

export function isVoiceSinkShapeType(shapeType) {
  if (!shapeType) return false
  return parseCsvPref(getPref('voice-sink-shape-types')).includes(shapeType)
}

export function maybeHandleVoiceSinkPointerDown(event) {
  const target = event?.target
  if (interactiveSinkChild(target)) return false
  const shapeEl = target?.closest?.('[data-shape-type]')
  const shapeType = shapeEl?.getAttribute?.('data-shape-type')
  if (!isVoiceSinkShapeType(shapeType)) return false
  enterVoiceSink()
  return true
}

// Second click on the <nowhere> shape: wipe ONLY the in-flight interim from the
// last real field voice was dictating into (the chat/text field) — left + right
// (committed text + anything after the cursor) stay untouched. Targets the field
// captured on entry, since by now voice is routed to nowhere.
function clearCurrentSinkInterim() {
  // The fix: wipe the in-flight interim from the last real field voice was
  // dictating into (left + right kept). This is the actual visible effect — the
  // old code only cleared the sink's own buffer, which renders nowhere (a no-op).
  const hadField = !!(_sinkPrevTextarea || _sinkPrevAccumulator)
  if (_sinkPrevTextarea) {
    // _sinkPrevLeft/_sinkPrevRight are committed (pre-speech + already-corrected dictated text).
    // Never re-run postProcessTranscript here — that would rewrite URLs and re-correct committed text.
    const kept = _sinkPrevLeft + _sinkPrevRight
    const cursor = _sinkPrevLeft.length
    _filling = true
    _sinkPrevTextarea.value = kept
    try { _sinkPrevTextarea.setSelectionRange(cursor, cursor) } catch { /* cursor restore is best-effort (element may not support selection) */ }
    _sinkPrevTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    _filling = false
  } else if (_sinkPrevAccumulator) {
    _sinkPrevAccumulator.onUpdate(_sinkPrevLeft + _sinkPrevRight)
  }
  // Also reset the sink's own (nowhere) buffer so the next dictation starts fresh.
  _state = 'edit'
  _left = _interim = _right = ''
  if (_backend === 'deepgram') resetDeepgramTextState()
  if (_backend === 'whisper-stream') flushWhisperBridge()
  showHud(hadField ? 'interim cleared' : '<nowhere> cleared', '#9370db')
  fadeHud(1500)
}

export function clearLastInterim() {
  if (!_voiceDumping) {
    _sinkPrevTextarea = _activeTextarea
    _sinkPrevAccumulator = _accumulator
    _sinkPrevLeft = _left
    _sinkPrevRight = _right
  }
  clearCurrentSinkInterim()
}

export function enterVoiceSink() {
  if (_voiceDumping) {
    clearCurrentSinkInterim()
    return
  }
  // Remember the real field (and its committed surroundings) before we drop it,
  // so a second click can wipe just its interim.
  _sinkPrevTextarea = _activeTextarea
  _sinkPrevAccumulator = _accumulator
  _sinkPrevLeft = _left
  _sinkPrevRight = _right
  if (_inputListeners && _activeTextarea) {
    _activeTextarea.removeEventListener('input', _inputListeners.input)
    _activeTextarea.removeEventListener('click', _inputListeners.click)
    _activeTextarea.removeEventListener('keydown', _inputListeners.keydown)
    _inputListeners = null
  }
  _activeTextarea = null
  _activeTargetHandle = null
  _accumulator = null
  _voiceDumping = true
  _state = 'edit'
  _left = _interim = _right = ''
  if (_backend === 'deepgram') resetDeepgramTextState()
  if (_backend === 'whisper-stream') flushWhisperBridge()
  if (_recording) showRecordingHud()
  else {
    showHud('voice → <nowhere>', '#9370db')
    fadeHud(2000)
  }
  emitVoiceTargetChange()
}

// --- Fill textarea with transcription ---

// Time-to-first-interim instrumentation (Item 2). Logs ONCE per recording the ms
// from record-start to the first transcript content reaching the field, tagged by
// backend — the only way to measure real first-interim latency on phone/iPad where
// we can't profile. Pure: label/log only, no behavior change.
function maybeMarkFirstInterim(content) {
  if (_firstInterimLogged || !_recording || !_recordStartTime) return
  if (!content || !String(content).trim()) return
  _firstInterimLogged = true
  log.info('voice', 'first-interim', {
    ms: Date.now() - _recordStartTime,
    backend: _backend,
    isTouch: _isTouchDevice,
    hostname: location.hostname,
  })
}

function fillTextarea(text) {
  maybeMarkFirstInterim(_accumulator ? (_left + _interim) : text)
  if (_accumulator) {
    // _left has corrections applied at commit; _interim has corrections applied when set.
    // Never re-run postProcessTranscript here — that would rewrite pre-speech text.
    _accumulator.onUpdate(_left + _interim)
    return
  }
  const ta = _activeTextarea
  if (!ta) return
  _filling = true
  ta.value = text
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  // Restore cursor to end of voice portion (between interim and right)
  if (_state === 'speech' && _right.length > 0) {
    const cursorPos = text.length - _right.length
    ta.setSelectionRange(cursorPos, cursorPos)
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  _filling = false
}

function formatMissingnessSeconds(ms) {
  const seconds = Math.max(0, ms / 1000)
  const rounded = seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function insertChromeMissingnessMarker(dropStartedAt, restartedAt = Date.now()) {
  if (!_recording || _backend !== 'chrome') return
  const hadSpeechText = !!String(_interim || '').trim() || (_state === 'speech' && !!String(_left || '').trim())
  if (!hadSpeechText) return
  const missingMs = restartedAt - dropStartedAt
  if (missingMs < CHROME_MIN_MISSINGNESS_MARKER_MS) return
  const seconds = formatMissingnessSeconds(restartedAt - dropStartedAt)
  const marker = `[missed ${seconds} seconds due to technical difficulties]`
  _lastChromeMissingnessMarker = marker

  if (_state !== 'speech') {
    _state = 'speech'
    const cursor = _activeTextarea?.selectionStart ?? (_activeTextarea?.value?.length ?? 0)
    _left = _activeTextarea?.value?.slice(0, cursor) ?? ''
    _right = _activeTextarea?.value?.slice(cursor) ?? ''
    _interim = ''
  }

  if (_interim) {
    _left += postProcessTranscript(_interim)
    _interim = ''
  }
  const previousMarkerRe = /\s*\[missed [^\]]+ due to technical difficulties\]\s*$/i
  if (previousMarkerRe.test(_left)) {
    _left = _left.replace(previousMarkerRe, ` ${marker} `)
  } else {
    _left += `${_left && !_left.endsWith(' ') ? ' ' : ''}${marker} `
  }
  fillTextarea(_left + _right)
}

function startChromeAfterUnexpectedStop(myGeneration, dropStartedAt) {
  if (!_recording || _backend !== 'chrome') return
  if (_chromeUnexpectedRestartFailures >= CHROME_UNEXPECTED_RESTART_LIMIT) {
    stopRecording()
    showHud('mic failed — tap to resume', '#c87070')
    fadeHud(5000)
    return
  }
  _chromeUnexpectedRestartFailures++
  if (_generation === myGeneration) _setupRecognition()
  try {
    showVoiceRestarting('speech recognition onend')
    _recognition.start()
    insertChromeMissingnessMarker(dropStartedAt)
    markVoiceRestarted()
  } catch (err) {
    if (err.name !== 'InvalidStateError') {
      stopRecording()
      showHud('mic failed — tap to resume', '#c87070')
      fadeHud(5000)
      return
    }
    setTimeout(() => {
      if (!_recording || _backend !== 'chrome') return
      try {
        showVoiceRestarting('speech recognition invalid-state retry')
        _recognition.start()
        insertChromeMissingnessMarker(dropStartedAt)
        markVoiceRestarted()
      } catch {
        startChromeAfterUnexpectedStop(myGeneration, dropStartedAt)
      }
    }, 100)
  }
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
    _chromeUnexpectedRestartFailures = 0
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
        _left += postProcessTranscript(e.results[i][0].transcript)
      } else {
        interim += e.results[i][0].transcript
      }
    }
    _interim = postProcessTranscript(interim)

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

      // Voice-send: saying the magic word submits exactly like pressing Enter.
      if (handleSendMagicWord(leftTrimmed)) return
    }

    fillTextarea(_left + _interim + _right)
  }

  _recognition.onerror = (e) => {
    if (e.error === 'no-speech') return
    if (e.error === 'aborted') return
    console.warn('voice: speech recognition error', e.error)
    // console.warn is NOT POSTed to client.log; route through the log sink so a
    // phone/iPad voice error is observable server-side (CLAUDE.md §Client Logging).
    log.warn('voice', 'web speech error', {
      error: e.error, backend: _backend, isIOS: _isIOS, isSafari: _isSafari,
      isTouch: _isTouchDevice, hostname: location.hostname,
    })
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
            showVoiceRestarting('audio-capture retry')
            _recognition.start()
            markVoiceRestarted()
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
          showVoiceRestarting('permission retry')
          _recognition.start()
          markVoiceRestarted()
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
          showVoiceRestarting('network retry')
          _recognition.start()
          markVoiceRestarted()
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
    if (e.error === 'service-not-allowed') {
      logSpeechContext('browser voice service refused', { error: e.error, retry: _serviceUnavailableRetries })
      if (_serviceUnavailableRetries < 1) {
        _serviceUnavailableRetries++
        showHud('checking Browser mic permission…', '#c8956a')
        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
          stream.getTracks().forEach(t => t.stop())
          logSpeechContext('browser voice mic probe passed', { retry: _serviceUnavailableRetries })
          if (!_recording) return
          _setupRecognition()
          try {
            showHud('mic allowed — retrying Browser voice…', '#c8956a')
            showVoiceRestarting('service permission retry')
            _recognition.start()
            logSpeechContext('browser voice retry started', { retry: _serviceUnavailableRetries })
            markVoiceRestarted()
            showRecordingHud()
          } catch (err) {
            console.warn('voice: service-not-allowed retry failed', err)
            logSpeechContext('browser voice retry threw', { retry: _serviceUnavailableRetries, error: err?.name || String(err) })
            stopRecording()
            showHud(serviceUnavailableMessage(_isIOS), '#c87070')
            fadeHud(8000)
          }
        }).catch((err) => {
          logSpeechContext('browser voice mic probe failed', { retry: _serviceUnavailableRetries, error: err?.name || String(err) })
          stopRecording()
          showHud(serviceUnavailableMessage(_isIOS), '#c87070')
          fadeHud(8000)
        })
      } else {
        logSpeechContext('browser voice service refused after retry', { error: e.error, retry: _serviceUnavailableRetries })
        stopRecording()
        showHud(serviceUnavailableMessage(_isIOS), '#c87070')
        fadeHud(8000)
      }
      return
    }
    showHud('mic error: ' + e.error, '#c87070')
    fadeHud(3000)
    _recording = false
  }

  _recognition.onend = () => {
    if (_recording) {
      const unexpectedStop = !_editStopped
      const dropStartedAt = Date.now()
      // Commit any pending interim to left so it survives the restart
      if (_state === 'speech' && _interim) {
        _left += _interim
        _interim = ''
      }
      _editStopped = false  // new session starting — ready for speech again
      if (unexpectedStop) {
        startChromeAfterUnexpectedStop(myGeneration, dropStartedAt)
        return
      }
      // If generation was bumped since this session was set up (e.g. chat-switch
      // or send keyword called _generation++ before our stop() triggered onend),
      // create a new SpeechRecognition object so its onresult closure captures
      // the current _generation. Without this, the restarted session would still
      // have the old myGeneration snapshot and discard every result it receives.
      if (_generation !== myGeneration) {
        _setupRecognition()
      }
      try {
        showVoiceRestarting('speech recognition onend')
        _recognition.start()
        markVoiceRestarted()
      } catch (err) {
        if (err.name !== 'InvalidStateError') throw err
        setTimeout(() => {
          if (!_recording) return
          showVoiceRestarting('speech recognition invalid-state retry')
          _recognition.start()
          markVoiceRestarted()
        }, 100)
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
  _lastWhisperMessageTime = Date.now()
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

    // Voice-send: saying the magic word submits exactly like pressing Enter.
    if (handleSendMagicWord(leftTrimmed)) return

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
// Browser captures mic via AudioWorklet, sends raw PCM to deepgram-sdk-bridge (ws:8180).
// Bridge relays to Deepgram API and returns transcripts with is_final flags.
// No echo/doubling — Deepgram manages interim vs final results cleanly.

let _deepgramWs = null
let _deepgramConnected = false
let _dgUpstreamPaused = false   // we've told the bridge to `stop` (routed-to-nowhere or tab backgrounded); not streaming
let _deepgramStream = null      // MediaStream from getUserMedia
let _deepgramContext = null      // AudioContext
let _deepgramWorklet = null      // AudioWorkletNode — captures mic on the audio thread, posts Int16 PCM
let _deepgramInterim = ''        // current interim result (replaced on each interim)
let _dgHasSeenInterim = false   // true after first interim in current session; guards against post-send final bleed
let _lastAudioChunkTime = 0     // timestamp of last audio chunk sent to bridge (for heartbeat logging)
let _lastMicFrameTime = 0       // timestamp of last RAW worklet frame (mic delivering), stamped pre-gate
let _audioHeartbeatInterval = null  // periodic interval that logs audio-flow health
let _dgTrickleWords = []         // words currently being trickled in
let _dgTrickleShown = 0          // how many trickle words are visible
let _dgTrickleTimer = null       // setTimeout id for next trickle step
let _dgTrickleDelay = 40         // ms between words (adjusted per burst)
let _dgIgnoreUntilUtteranceEnd = false // true after voice-send; drops trailing old-utterance results
let _dgIgnoredSubmittedText = null // normalized utterance submitted before waiting for utterance_end
let _dgLastFinalNorm = ''        // last committed final; used to drop duplicate stale finals
let _dgLastFinalAt = 0           // timestamp for same-final echo suppression
const DEEPGRAM_REPEAT_ECHO_WINDOW_MS = 1200

function _dgTrickleFlush() {
  clearTimeout(_dgTrickleTimer)
  _dgTrickleTimer = null
}

function normalizeDeepgramText(text) {
  return String(text || '')
    .replace(/[.!?,;:]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function resetDeepgramTextState({ ignoreUntilUtteranceEnd = false, submittedText = null, preserveLastFinal = false, preserveUtteranceGuard = false } = {}) {
  _deepgramInterim = ''
  _dgHasSeenInterim = false
  if (!preserveUtteranceGuard) {
    _dgIgnoreUntilUtteranceEnd = ignoreUntilUtteranceEnd
    _dgIgnoredSubmittedText = ignoreUntilUtteranceEnd ? normalizeDeepgramText(submittedText) : null
  }
  if (!preserveLastFinal) _dgLastFinalNorm = ''
  if (!preserveLastFinal) _dgLastFinalAt = 0
  _dgTrickleFlush()
  _dgTrickleWords = []
  _dgTrickleShown = 0
}

function currentSubmittedVoiceText() {
  if (_activeTextarea?.value) return _activeTextarea.value
  return [_left, _interim].filter(Boolean).join(' ')
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sendMagicWordRe() {
  const words = parseCsvPref(getPref('voice-submit-words'))
  if (words.length === 0) return null
  const body = words
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  return new RegExp(`(?:${body})\\s*[.!,]?\\s*$`, 'i')
}

function splitSendMagicWord(text) {
  const re = sendMagicWordRe()
  if (!re) return null
  const match = text.trim().match(re)
  if (!match) return null
  return text.trim().slice(0, match.index).trim()
}

function replaceTextareaValue(text) {
  const ta = _activeTextarea
  if (!ta) return false
  _filling = true
  ta.value = text
  ta.style.height = text && ta.scrollHeight ? Math.min(ta.scrollHeight, 200) + 'px' : 'auto'
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  _filling = false
  return true
}

function pressEnterOnActiveTextarea() {
  const ta = _activeTextarea
  if (!ta) {
    showHud('no chat focused', '#c8956a')
    fadeHud(2000)
    return false
  }
  if (typeof KeyboardEvent === 'undefined') {
    throw new Error('voice send magic word requires KeyboardEvent')
  }
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, '__tldaVoiceSubmit', { value: true })
  return ta.dispatchEvent(event)
}

function submitTextareaViaMagicWord(cleanText, submittedText) {
  replaceTextareaValue(cleanText)
  pressEnterOnActiveTextarea()
  if (_backend === 'deepgram') resetDeepgramTextState({ ignoreUntilUtteranceEnd: true, submittedText })
}

function handleSendMagicWord(leftTrimmed) {
  const cleanText = splitSendMagicWord(leftTrimmed)
  if (cleanText === null) return false

  if (_accumulator && _accumulator.onSend) {
    if (!cleanText) return false
    _accumulator.onSend(cleanText)
    showHud('sent', '#7ab8a0')
    fadeHud(2500)
    afterSend()
    if (_backend === 'deepgram') resetDeepgramTextState({ ignoreUntilUtteranceEnd: true, submittedText: leftTrimmed })
    return true
  }

  if (_activeTextarea) {
    submitTextareaViaMagicWord(cleanText, leftTrimmed)
    return true
  }

  showHud('no chat focused', '#c8956a')
  fadeHud(2000)
  afterSend()
  if (_backend === 'deepgram') resetDeepgramTextState({ ignoreUntilUtteranceEnd: true, submittedText: leftTrimmed })
  return true
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

    if (msg.type === 'speech_started') {
      _lastResultTime = Date.now()
      dotAudioFlowing()
      _dgLastFinalNorm = ''
      _dgLastFinalAt = 0
      vlog('speech started')
      return
    }

    if (msg.type === 'utterance_end') {
      _dgIgnoreUntilUtteranceEnd = false
      _dgIgnoredSubmittedText = null
      _dgLastFinalNorm = ''
      _dgLastFinalAt = 0
      if (_deepgramInterim || _interim) {
        resetDeepgramTextState()
        _interim = ''
        fillTextarea(_left + _right)
      }
      return
    }

    if (msg.type !== 'transcript' || !msg.text) return

    if (_dgIgnoreUntilUtteranceEnd) {
      const normalized = normalizeDeepgramText(msg.text)
      if (_dgIgnoredSubmittedText && (_dgIgnoredSubmittedText.includes(normalized) || normalized.includes(_dgIgnoredSubmittedText))) {
        vlog('DROPPED transcript (waiting for utterance end)', { final: !!msg.is_final, text: msg.text.slice(0, 30) })
        return
      }
      vlog('released utterance-end guard on fresh transcript', { final: !!msg.is_final, text: msg.text.slice(0, 30) })
      _dgIgnoreUntilUtteranceEnd = false
      _dgIgnoredSubmittedText = null
    }

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
      resetDeepgramTextState()
    }

    const text = msg.text

    if (msg.is_final) {
      // Final result — append to committed text, clear interim
      _dgTrickleFlush()
      const processed = postProcessTranscript(text)
      const normalizedFinal = normalizeDeepgramText(processed)
      if (normalizedFinal && normalizedFinal === _dgLastFinalNorm && !_dgHasSeenInterim) {
        vlog('DROPPED transcript (duplicate final)', { text: text.slice(0, 30) })
        return
      }
      _left += (_left.length && !_left.endsWith(' ') ? ' ' : '') + processed
      _dgLastFinalNorm = normalizedFinal
      _dgLastFinalAt = Date.now()
      resetDeepgramTextState({ preserveLastFinal: true })
      _interim = ''
    } else {
      // Interim — trickle new words in one at a time, smoothed
      const normalizedInterim = normalizeDeepgramText(postProcessTranscript(text))
      const sinceLastFinal = _dgLastFinalAt ? Date.now() - _dgLastFinalAt : Infinity
      if (normalizedInterim && normalizedInterim === _dgLastFinalNorm && sinceLastFinal <= DEEPGRAM_REPEAT_ECHO_WINDOW_MS) {
        vlog('DROPPED transcript (duplicate interim)', { text: text.slice(0, 30), sinceLastFinal })
        return
      }
      _deepgramInterim = text
      _dgHasSeenInterim = true   // saw an interim → finals for this utterance are valid
      _dgLastFinalNorm = ''
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
        resetDeepgramTextState({ ignoreUntilUtteranceEnd: true })
        setTimeout(() => { if (_recording) showRecordingHud() }, 1600)
        return
      }
    }

    // Voice-send: only final Deepgram results may submit. Interim "send" text
    // is displayed but never fires, so the following final cannot double-send.
    if (msg.is_final && handleSendMagicWord(leftTrimmed)) return

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
    _voiceHealthLabel = 'connecting to recognizer'
    if (_recording) showRecordingHud()
    _deepgramWs = new WebSocket(deepgramBridgeUrl())
    _deepgramWs.onopen = () => {
      _deepgramConnected = true
      hideDontSpeak()
      _voiceHealthLabel = 'recognizer connected'
      showRecordingHud()
      vlog('bridge WS open')
      _dgUpstreamPaused = false   // fresh bridge session starts streaming
      _deepgramWs.send(dgStartMsg())
    }
    _deepgramWs.onmessage = onDeepgramMessage
    _deepgramWs.onclose = () => {
      _deepgramConnected = false
      _deepgramWs = null
      vlog('bridge WS closed', { recording: _recording })
      showDontSpeak('connection lost; reconnecting')
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

// What the audio heartbeat should do, decided ONLY from the AudioContext state.
// This is the root-cause rule for the intermittent cut-outs / false "stop talking"
// (see the long comment at the heartbeat call site): a 'running' (or unknown)
// context is alive — NEVER tear it down on a timing heuristic, because the
// teardown is itself what manufactures the cut-out. 'suspended' is repaired
// cheaply by resume(); only a 'closed' context is genuinely dead and warrants a
// rebuild. Pulled out as a pure function so this rule is unit-testable.
function micWatchdogAction(ctxState) {
  if (ctxState === 'suspended') return 'resume'
  if (ctxState === 'closed') return 'rebuild'
  return 'none'
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
      showDontSpeak('mic stopped; restarting')
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
  const source = _deepgramContext.createMediaStreamSource(_deepgramStream)

  // Capture on the audio thread via an AudioWorklet. Unlike ScriptProcessor it
  // does NOT need to be connected to the destination to run, so there's no
  // silent-gain hack and nothing can leak recycled garbage to the iPad speaker.
  // The worklet downsamples to 16k and posts Int16 PCM back here; we relay it to
  // the bridge. AudioWorklet is also far more robust under iOS audio-session
  // interruptions than ScriptProcessor (the source of the constant mic restarts).
  try {
    await _deepgramContext.audioWorklet.addModule(`${import.meta.env.BASE_URL}deepgram-capture-worklet.js`)
  } catch (err) {
    vlog('audioWorklet.addModule failed', { err: err?.message })
    showHud('mic init failed — tap to retry', '#c87070')
    fadeHud(5000)
    stopDeepgramMic()
    return
  }
  // addModule is async — a stop or backend switch may have torn the context
  // down while we awaited. Bail rather than build a node on a dead context.
  if (!_deepgramContext || !_deepgramStream) return

  _deepgramWorklet = new AudioWorkletNode(_deepgramContext, 'deepgram-capture')
  _deepgramWorklet.port.onmessage = (e) => {
    _lastMicFrameTime = Date.now()   // raw mic delivery — stamped BEFORE the route/idle gate so a paused-but-live mic still reads as live
    sendDeepgramAudioChunk(e.data)
  }
  source.connect(_deepgramWorklet)
  _voiceHealthLabel = _deepgramConnected ? 'mic live; waiting for speech' : 'mic live; waiting for recognizer'
  if (_recording) showRecordingHud()

  _lastAudioChunkTime = 0
  _audioHeartbeatInterval = setInterval(() => {
    if (!_recording) return
    const ago = _lastAudioChunkTime ? Date.now() - _lastAudioChunkTime : null
    const ctxState = _deepgramContext?.state
    vlog('audio heartbeat', {
      lastChunkMs: ago,
      wsOpen: _deepgramConnected,
      hasMic: !!_deepgramStream,
      audioCtxState: ctxState,
    })
    const action = micWatchdogAction(ctxState)

    // A suspended context (tab backgrounded, OS audio pause) is the one benign
    // state we actively repair — resume() is cheap and non-destructive. It does
    // NOT interrupt an in-flight utterance the way a teardown does.
    if (action === 'resume') {
      vlog('audio heartbeat: AudioContext suspended — resuming')
      _deepgramContext.resume()
        .then(() => vlog('audio heartbeat: AudioContext resumed'))
        .catch(err => vlog('audio heartbeat: resume failed', { err: err.message }))
      return
    }

    // ROOT CAUSE of the intermittent cut-outs / false "stop talking" (the thing
    // Skip said WAS the point, and questioned: "2s is a long time — is this even
    // the problem?"). It is. The old code restarted the whole mic pipeline on any
    // `ago > 2000`. But `_lastAudioChunkTime` is stamped on the MAIN thread (in
    // sendDeepgramAudioChunk, and ONLY while the bridge WS is open), and this
    // interval also runs on the main thread. So `ago` goes stale for reasons that
    // have NOTHING to do with the audio pipeline being dead:
    //   1. a long main-thread task (iPad TLDraw render/GC) defers the worklet's
    //      port.onmessage AND this interval — when they finally run, the interval
    //      can read a pre-jank timestamp (the 6/19 incident: lastChunkMs:2702 with
    //      wsOpen, hasMic, audioCtxState all healthy);
    //   2. a brief iOS audio-session duck: process() runs with empty input, posts
    //      nothing, context stays "running";
    //   3. a transient bridge-WS blip: the worklet keeps posting, but
    //      sendDeepgramAudioChunk early-returns without stamping the timestamp
    //      while onclose already reconnects.
    // In every one of these the AudioContext is "running"/"suspended", never dead.
    // Tearing it down (close ctx + stop tracks + new getUserMedia + async
    // addModule) GUARANTEES a 1–3s real cut-out and flashes the false "mic stalled"
    // overlay — it MANUFACTURES the exact symptom it claimed to prevent, and resets
    // the timer so it can re-arm into a loop. So: never restart on this heuristic.
    // Genuine death is caught by real events instead — the mic track's `onended`
    // (OS killed the mic) and the bridge WS `onclose` (reconnect). The only death
    // those two miss that this heartbeat can see is a context that went "closed"
    // out from under us; that — and only that — warrants a rebuild.
    if (action === 'rebuild' && _backend === 'deepgram') {
      vlog('audio heartbeat: AudioContext closed — rebuilding mic pipeline')
      showDontSpeak('mic stopped; restarting')
      stopDeepgramMic()
      startDeepgramMic()
      return
    }

    // Honest mic status is label-only and shared with the other backends by
    // runVoiceLivenessWatchdog(). This heartbeat remains responsible only for
    // logging and event-backed Deepgram repairs.
  }, 1000)
}

function stopDeepgramMic() {
  clearInterval(_audioHeartbeatInterval)
  _audioHeartbeatInterval = null
  if (_deepgramWorklet) {
    try { _deepgramWorklet.port.onmessage = null; _deepgramWorklet.disconnect() } catch {}
    _deepgramWorklet = null
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
  if (_backend === 'whisper-stream') {
    flushWhisperBridge()
    return
  }
  if (_backend === 'deepgram') {
    const submittedText = currentSubmittedVoiceText()
    finalizeDeepgramBridge()
    if (normalizeDeepgramText(submittedText)) resetDeepgramTextState({ ignoreUntilUtteranceEnd: true, submittedText })
    else resetDeepgramTextState({ preserveUtteranceGuard: true })
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
// `[voice] <text>` to ~/.config/tlda/deepgram-sdk-bridge.log so Safari debug is
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
    fakeRecord: (ta) => { _recording = true; _state = 'edit'; _backend = 'deepgram'; _voiceDumping = false; resetDeepgramTextState(); if (ta) _activeTextarea = ta; },
    fakeStop: () => { _recording = false; stopVoiceLivenessWatchdog(); stopDeepgramMic(); resetDeepgramTextState(); },
    switchTarget: (ta, sendTargets = [], agentNames = {}, agentColor = null) => setVoiceTarget(ta, {
      getSendTargets: () => sendTargets,
      getAgentNames: () => agentNames,
      getAgentColor: () => agentColor,
      sendVoice: () => {},
    }),
    getState: () => ({ recording: _recording, backend: _backend, state: _state, connected: _deepgramConnected, hasMic: !!_deepgramStream, left: _left, interim: _interim, dumping: _voiceDumping, hasTextarea: !!_activeTextarea }),
    injectTranscript: (text, isFinal) => onDeepgramMessage({ data: JSON.stringify({ type: 'transcript', text, is_final: isFinal, speech_final: false }) }),
    afterSend: () => afterSend(),
    getTrickle: () => ({ words: _dgTrickleWords.slice(), shown: _dgTrickleShown, hasTimer: _dgTrickleTimer !== null }),
    showDontSpeak: () => showDontSpeak(),
    isDontSpeakVisible: () => !!_dontSpeakOverlay && _dontSpeakOverlay.style.display === 'block',
    getVoiceStatusLabel: () => voiceStatusLabel(),
    getHudText: () => _hud?.textContent || '',
    getHudStyle: () => _hud?.style || null,
    getHudWidth: () => VOICE_HUD_WIDTH,
    getRadioSubtitle: () => _radioSubtitle ? { ..._radioSubtitle, expanded: _radioExpanded } : null,
    maybeShowRadioSubtitleForIncomingChat,
    fakeDeepgramConnected: () => {
      _recording = true
      _backend = 'deepgram'
      _deepgramConnected = true
      _deepgramWs = { readyState: 1, send: () => {}, close: () => {}, onclose: null }
    },
    simulateDeepgramAudioFrame: (data = new Int16Array([1]).buffer) => sendDeepgramAudioChunk(data),
    micWatchdogAction: (ctxState) => micWatchdogAction(ctxState),
    upstreamAction: (s) => upstreamAction(s),
    micPresence: (micAgo, ctxState, timeoutMs) => micPresence(micAgo, ctxState, timeoutMs),
    chromeLiveness: (resultAgo, hasActiveSession, editStopped, deadTimeoutMs) => chromeLiveness(resultAgo, hasActiveSession, editStopped, deadTimeoutMs),
    whisperLiveness: (messageAgo, wsReadyState, connected, timeoutMs) => whisperLiveness(messageAgo, wsReadyState, connected, timeoutMs),
    serviceUnavailableMessage: (isIOS) => serviceUnavailableMessage(isIOS),
    injectDeepgramMessage: (message) => onDeepgramMessage({ data: JSON.stringify(message) }),
    dotAudioStale: () => dotAudioStale(),
    getHealthLabel: () => _voiceHealthLabel,
    getLastChromeMissingnessMarker: () => _lastChromeMissingnessMarker,
    insertChromeMissingnessMarker: (dropStartedAt, restartedAt) => insertChromeMissingnessMarker(dropStartedAt, restartedAt),
    formatMissingnessSeconds: (ms) => formatMissingnessSeconds(ms),
    shouldAutoStartOnInit: (isTouch, backend) => shouldAutoStartOnInit(isTouch, backend),
  }
}

function startRecording() {
  vlog('startRecording', { backend: _backend, recording: _recording, hasTextarea: !!_activeTextarea, hasAccumulator: !!_accumulator })
  if (_recording) return
  if (_backend === 'none') return   // no backend enabled — voice is off
  if (_backend === 'chrome' && !SpeechRecognition) return

  // No guard on having a target: recording can run targetless. With no
  // accumulator/textarea, fillTextarea discards the stream until a target is
  // selected. The mic stays live regardless — only the mic button stops it.

  _micChannel?.postMessage('mic-start')

  _recording = true
  _dgUpstreamPaused = false   // fresh recording — upstream is active until routing/tab says otherwise
  emitRecordingChange()
  _state = 'edit'
  _generation++
  _left = _interim = _right = ''
  _lastResultTime = 0
  _lastWhisperMessageTime = 0
  _lastChromeMissingnessMarker = ''
  _chromeUnexpectedRestartFailures = 0
  _recordStartTime = Date.now()   // Item 2: measure time-to-first-interim
  _firstInterimLogged = false

  showRecordingHud()
  dotRecordingStart()
  startVoiceLivenessWatchdog()

  _audioCaptureRetries = 0
  _serviceUnavailableRetries = 0

  if (_backend === 'deepgram') {
    connectDeepgramBridge()
    startDeepgramMic()
    // Ensure Deepgram session is started (may have been stopped by hardResetVoice)
    if (_deepgramWs && _deepgramConnected) {
      try { _deepgramWs.send(dgStartMsg()) } catch { /* WS race; onopen re-sends start */ }
    }
  } else if (_backend === 'whisper-stream') {
    // whisper-stream captures mic directly — no browser mic needed.
    // Just ensure we're connected to the bridge WebSocket.
    connectWhisperBridge()
  } else {
    logSpeechContext('browser voice start requested')
    showHud('starting Browser voice…', '#c8956a')
    const doStart = () => {
      if (!_recording) return
      _setupRecognition()
      try {
        _recognition.start()
        logSpeechContext('browser voice recognizer start called')
      } catch (err) {
        console.warn('voice: could not start recognition', err)
        logSpeechContext('browser voice start threw', { error: err?.name || String(err) })
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
  emitRecordingChange()

  stopVoiceLivenessWatchdog()
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
    // Lightweight reset for chat switch — keep the warm bridge/mic and drop
    // trailing transcripts from the old utterance until Deepgram ends it.
    vlog('hardReset/dg: keeping mic warm', { wsOpen: _deepgramConnected, hasMic: !!_deepgramStream })
  } else {
    disconnectDeepgramBridge()
  }
  resetDeepgramTextState({ ignoreUntilUtteranceEnd: _backend === 'deepgram' && keepDeepgramMic })
  _recording = false
  _state = 'edit'
  _accumulator = null
  _left = _interim = _right = ''
  _editStopped = false
  _filling = false
  _audioCaptureRetries = 0
  _serviceUnavailableRetries = 0
  _lastResultTime = 0
  _lastWhisperMessageTime = 0
  stopVoiceLivenessWatchdog()
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

  const targets = activeSendTargets()
  if (targets.length === 0) {
    showHud('no send target', '#c8956a')
    fadeHud(2000)
    return
  }

  if (_activeTargetHandle?.sendVoice) {
    _activeTargetHandle.sendVoice(targets, text)
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

  // Voice backend selection is EXPLICIT ONLY. The backend is whatever the user
  // enabled in Preferences — there is no URL override, no implicit default, no
  // auto-selection (not even the protective iPad→deepgram one), and no fallback.
  // If nothing is enabled, voice stays OFF and silent. This is the rule that
  // keeps any backend the user didn't choose — in particular iOS/Chrome Web
  // Speech, whose start/stop earcon ignores the silent switch — from ever
  // running unbidden.
  // Wait for the saved pref to load before committing — never pick a backend
  // before we know what the user actually selected. Cap at 2s.
  await Promise.race([whenPrefsLoaded(), new Promise(r => setTimeout(r, 2000))])
  let prefBackend = getPref('voice-backend')   // 'deepgram-sdk' | 'whisper' | 'chrome' | '' (off)

  if (prefBackend === 'chrome') {
    _backend = 'chrome'
    console.log('voice: using Chrome Web Speech API (explicitly enabled)')
  } else if (prefBackend === 'whisper') {
    _backend = 'whisper-stream'
    try {
      await fetch('/api/voice/whisper/start', { method: 'POST' })
    } catch (err) {
      console.warn('voice: whisper lazy-start request failed', err)
    }
    // Connect lazily. If the bridge never comes up, voice is simply unavailable
    // — we do NOT fall back to anything that could make a sound.
    _whisperAvailable = true
    connectWhisperBridge()
    console.log('voice: using whisper-stream backend (explicitly enabled)')
  } else if (prefBackend === 'deepgram' || prefBackend === 'deepgram-sdk') {
    _backend = 'deepgram'
    try {
      await fetch('/api/voice/deepgram-sdk/start', { method: 'POST' })
    } catch (err) {
      console.warn('voice: deepgram lazy-start request failed', err)
    }
    // Connect lazily when recording starts. No probe-and-fallback: if the bridge
    // is unreachable, recording just does nothing — never a fallback.
    _deepgramAvailable = true
    console.log('voice: using deepgram SDK backend (explicitly enabled)')
  } else {
    // No backend enabled → voice is OFF. Nothing runs, nothing makes a sound.
    _backend = 'none'
    console.log('voice: no backend enabled — voice off (select one in Preferences)')
  }

  // Ground-truth diagnostic — lands in ~/.config/tlda/client.log so we can see
  // exactly which backend a device chose (and why) without a console.
  log.info('voice', 'backend selected', {
    backend: _backend,
    prefBackend,
    isTouch: _isTouchDevice,
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : null,
    onServerHost: _onServerHost,
    hostname: location.hostname,
  })

  if (_backend === 'chrome' && !SpeechRecognition) {
    console.warn('voice: chrome selected but SpeechRecognition unavailable — voice off')
    _backend = 'none'
  }

  // initVoice() runs at FleetChatShape module load, which can beat fleet login
  // and the async loadPrefs() call. If the 2s startup cap fires first, keep the
  // initialized voice shell alive and apply the saved backend when prefs arrive.
  subscribePref(() => {
    const nextPrefBackend = getPref('voice-backend')
    if (nextPrefBackend === prefBackend) return
    prefBackend = nextPrefBackend
    setBackend(nextPrefBackend)
  })

  // Right Shift: tap counting within 300ms windows.
  //   1 tap  → toggle recording
  //   2 taps → soft reset (kill playwright, getUserMedia cycle, restart)
  //   3 taps → kill Chrome and reopen (tlda://voice-reset)
  //
  // The handler is installed on document AND on any iframe contentDocuments
  // (via MutationObserver) so shift works regardless of where focus is.
  function shiftHandler(e) {
    if (e.code !== 'ShiftRight') return
    e.preventDefault()
    e.stopImmediatePropagation()
    voiceTap()
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
    // Active-tab-only: a backgrounded tab releases its upstream Deepgram session
    // (don't stream from a tab nobody's looking at — those phantom sessions fed
    // the storm). reconcileUpstream() sees document.hidden and sends `stop`; the
    // AudioContext may suspend on background, so we can't rely on the audio path.
    if (document.hidden && _recording && _backend === 'deepgram') {
      reconcileUpstream()
      return
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
        // Foreground again → restore upstream (reconcileUpstream sends `start`).
        reconcileUpstream()
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

  const backend = _backend === 'deepgram' ? 'deepgram-sdk' : _backend === 'whisper-stream' ? 'whisper' : 'Web Speech API'
  console.log(`voice: initialized v8 — ${backend} — BroadcastChannel: ${!!_micChannel}`)
  if (shouldAutoStartOnInit(_isTouchDevice, _backend)) startRecording()
  return _backend !== 'none'
}

// --- Public controls ---

export function toggleRecording() {
  if (_recording) { stopRecording() } else { startRecording() }
}

export function restartRecording() {
  if (!_recording) return
  if (_backend === 'deepgram') {
    showRecordingHud()
    return
  }
  stopRecording()
  startRecording()
}

export { sendCurrentText, stopRecording }

// --- State queries ---

export function isRecording() { return _recording }
export function getTranscript() {
  if (_accumulator) return _left + _interim
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
export async function setBackend(be) {
  if (be === 'whisper') be = 'whisper-stream' // prefs dropdown uses the short name
  if (be === 'deepgram' || be === 'deepgram-sdk') be = 'deepgram'
  // Explicit "off": no backend enabled. Stop any recording and go silent.
  if (be === '' || be === 'none') {
    if (_recording) stopRecording()
    _backend = 'none'
    showHud('voice: off', '#9370db')
    fadeHud(2000)
    return
  }
  if (be !== 'chrome' && be !== 'whisper-stream' && be !== 'deepgram') return
  if (be === _backend) return
  if (be === 'chrome' && !SpeechRecognition) return
  // Lazy-start the target backend on demand. init only starts the backend it
  // commits to; a live switch or late-loaded saved pref must start its selected
  // backend here instead of silently no-oping on a stale availability flag.
  if (be === 'deepgram') {
    try { await fetch('/api/voice/deepgram-sdk/start', { method: 'POST' }) } catch {}
    _deepgramAvailable = true
  }
  if (be === 'whisper-stream') {
    try {
      await fetch('/api/voice/whisper/start', { method: 'POST' })
    } catch (err) {
      console.warn('voice: whisper lazy-start request failed', err)
      showHud('voice: whisper unavailable', '#c8956a')
      fadeHud(2000)
      return
    }
    _whisperAvailable = true
    connectWhisperBridge()
  }
  const wasRecording = _recording
  if (wasRecording) stopRecording()
  _backend = be
  if (wasRecording) startRecording()
  showHud(`voice: ${be === 'deepgram' ? 'deepgram-sdk' : be}`, '#9370db')
  fadeHud(2000)
}
/** @param {string | null | undefined} submittedText */
export function resetTranscript(submittedText = undefined) {
  _state = 'edit'
  _generation++
  _left = _interim = _right = ''
  if (_backend === 'deepgram') {
    if (submittedText != null) resetDeepgramTextState({ ignoreUntilUtteranceEnd: true, submittedText })
    else resetDeepgramTextState({ preserveUtteranceGuard: true })
  }
  if (_backend === 'whisper-stream') flushWhisperBridge()
  if (_recording && _recognition) {
    try { _recognition.stop() } catch {}
  }
}
