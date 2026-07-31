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
import { getPref, normalizeRadioSubtitleDwellSec, subscribePref, whenPrefsLoaded } from './preferences.ts'
import { PcmBacklog, deliverVoiceComposition, partitionAtCursor, pcmInputLevel, voiceIndicatorState } from './voice-indicator.mjs'

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

async function classifyMicFailure(err, source = 'capture') {
  let permissionState = null
  let permissionError = null
  try {
    const permissions = navigator.permissions
    if (!permissions?.query) throw new Error('Permissions API unavailable')
    permissionState = (await permissions.query({ name: 'microphone' }))?.state || null
  } catch (permissionErr) {
    permissionError = permissionErr?.name || String(permissionErr)
  }

  const errorName = err?.name || 'UnknownError'
  if (permissionState === 'denied') {
    return { kind: 'denied', label: 'mic denied — check permissions', errorName, permissionState, permissionError }
  }
  if (source === 'recognition-start') {
    return { kind: 'recognition-unavailable', label: 'Browser voice unavailable — retry failed', errorName, permissionState, permissionError }
  }
  if (errorName === 'NotFoundError') {
    return { kind: 'not-found', label: 'no microphone found', errorName, permissionState, permissionError }
  }
  if (errorName === 'NotReadableError' || errorName === 'AbortError') {
    return { kind: 'unavailable', label: 'microphone unavailable or busy', errorName, permissionState, permissionError }
  }
  return { kind: 'unavailable', label: 'microphone unavailable', errorName, permissionState, permissionError }
}

// --- Backend selection ---
const WHISPER_BRIDGE_URL = location.protocol === 'https:' ? 'wss://127.0.0.1:8179' : 'ws://127.0.0.1:8179'

// Deepgram bridge URL. Deepgram is SDK-only — one implementation (Skip, 6/19:
// "we're going with the SDK implementation, it is better") — and there is ONE
// bridge, on its own machine. Either we are told its address and connect to it
// directly, or we relay through the same-origin /voice/deepgram-sdk WS proxy on
// the tlda server, reusing the page's TLS + token. There is no third route: the
// "we happen to be on the server's own host, so try 127.0.0.1:8180" branch is
// gone with the local bridge it reached (Skip: "strip. simplify").
// The voice box's own address, handed to us by the server (TLDA_VOICE_DIRECT_URL)
// in the /api/voice/deepgram-sdk/start reply, which every connect path awaits
// before opening this socket. Empty means no voice box is configured.
let _directBridgeUrl = ''

// Record the voice-box address the server advertises. Logged on change, because
// which machine his audio goes to is exactly the thing that must never quietly
// differ from what we think it is.
function setDirectBridgeUrl(url) {
  const next = typeof url === 'string' ? url : ''
  if (next === _directBridgeUrl) return
  _directBridgeUrl = next
  console.log(next
    ? `voice: deepgram bridge is the voice box at ${next}`
    : 'voice: no voice box configured - using the same-origin proxy')
}

function deepgramBridgeUrl() {
  // Prefer the voice box. Connecting to it directly is the entire point: the
  // socket then lives on a machine that app deploys do not restart, so deploying
  // the app cannot cut Skip off mid-sentence. Reachability is by tailnet
  // membership, which is the whole auth posture - no token is appended.
  if (_directBridgeUrl) return _directBridgeUrl
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
const VOICE_HUD_MIN_WIDTH = 240
const VOICE_HUD_WIDTH = `${VOICE_HUD_MIN_WIDTH}px`
const VOICE_METER_BACKGROUND = 'background'
const VOICE_METER_EDGE = 'edge'
const RADIO_HUD_MAX_CHARS = 700
const RADIO_HUD_HISTORY_LIMIT = 4

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
let _speechEpoch = 0
function advanceSpeechEpoch() {
  _speechEpoch++
  // Captured PCM belongs to exactly one transcript/message epoch. Any boundary
  // (send, target switch, reset, restart) invalidates the old audio eagerly.
  _deepgramAudioBacklog.clear()
}

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
let _radioHistory = []
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

function isDocSurface() {
  if (typeof document === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).has('project')
  } catch {
    return false
  }
}

function radioHudPageLayout() {
  if (typeof document === 'undefined') return null
  const candidates = []
  for (const el of document.querySelectorAll('.svg-page-background, iframe')) {
    if (el.tagName === 'IFRAME') {
      const src = el.getAttribute('src') || ''
      if (!src.includes('/docs/')) continue
    }
    const rect = el.getBoundingClientRect()
    if (rect.width < 120 || rect.height < 120) continue
    if (rect.right < 0 || rect.left > window.innerWidth) continue
    candidates.push(rect)
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    const aVisible = Math.max(0, Math.min(a.right, window.innerWidth) - Math.max(a.left, 0))
    const bVisible = Math.max(0, Math.min(b.right, window.innerWidth) - Math.max(b.left, 0))
    return bVisible - aVisible || b.width - a.width
  })
  const page = candidates[0]
  const maxVisibleWidth = Math.max(VOICE_HUD_MIN_WIDTH, window.innerWidth - 24)
  const width = Math.max(VOICE_HUD_MIN_WIDTH, Math.min(page.width * 0.75, maxVisibleWidth))
  const pageCenter = page.left + page.width / 2
  const half = width / 2
  const left = Math.max(12 + half, Math.min(window.innerWidth - 12 - half, pageCenter))
  return { width, left }
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
  const entry = {
    from,
    label: labelForRadioAgent(from, agents),
    text,
    timestamp: event.timestamp || new Date().toISOString(),
  }
  _radioSubtitle = entry
  _radioHistory = [entry, ..._radioHistory].slice(0, RADIO_HUD_HISTORY_LIMIT)
  _radioExpanded = true
  clearTimeout(_radioCollapseTimer)
  showHud(`radio <- ${_radioSubtitle.label}`, '#7ab8a0')
  const dwellSec = normalizeRadioSubtitleDwellSec(getPref('radio-subtitle-dwell-sec'))
  _radioCollapseTimer = setTimeout(collapseRadioSubtitle, dwellSec * 1000)
  return true
}

export function maybeShowRadioSubtitleForIncomingChat(event, agents = [], humanId = null) {
  if (!getPref('radio-subtitles-enabled')) return false
  if (!isDocSurface()) return false
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

// HUD meter: fixed color; amplitude changes the painted area only. Voice state
// remains text, not a meter color channel.
const DOT_GREEN = '#7ab8a0'
const DOT_AMBER = '#c8956a'
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

function voiceCanReportRawAudioFlowing() {
  if (_backend !== 'deepgram') return true
  return _deepgramRelayConnected &&
    deepgramRecognizerConnected() &&
    _deepgramReadyEpoch === _speechEpoch &&
    !_deepgramPcmPaused
}

function shouldAutoStartOnInit() {
  // initVoice() should only install controls and select the saved backend. Starting
  // capture on page load creates hidden prompts, Web Speech gesture failures, and
  // confusing retry/status churn on phone.
  return false
}

let _micLevel = 0
let _micLevelPending = 0
let _micLevelRaf = null
let _micAudible = false
let _healthDotTimer = null
let _voiceHealthLabel = ''
let _lastStatusWord = null   // last status word actually rendered, so the 1 Hz watchdog repaints only on a real change
let _voiceLivenessInterval = null
let _lastWhisperMessageTime = 0

function normalizeVoiceMeterMode(value) {
  return value === VOICE_METER_EDGE ? VOICE_METER_EDGE : VOICE_METER_BACKGROUND
}

function micLevelGradient(level, color, alpha) {
  const pct = Math.round(Math.min(1, Math.max(0, level)) * 100)
  return `linear-gradient(90deg, ${hexToRgba(color, alpha * 0.35)} 0%, ${hexToRgba(color, alpha)} ${pct}%, transparent ${pct}%, transparent 100%)`
}

function paintMicLevel(level = _micLevel) {
  if (!_hud) return
  const displayedLevel = _recording ? Math.max(0.025, Math.min(1, Math.max(0, level))) : 0
  const mode = normalizeVoiceMeterMode(getPref('voice-hud-meter'))
  const base = 'rgba(255,255,255,0.08)'
  _hud.style.backgroundColor = base
  _hud.style.backgroundImage = micLevelGradient(displayedLevel, DOT_GREEN, mode === VOICE_METER_EDGE ? 0.5 : 0.16)
  _hud.style.backgroundRepeat = 'no-repeat'
  _hud.style.backgroundSize = mode === VOICE_METER_EDGE ? '100% 2px' : '100% 100%'
  _hud.style.backgroundPosition = mode === VOICE_METER_EDGE ? 'left bottom' : 'left top'
}

function setMicInputLevel(level) {
  _micLevelPending = level
  if (_micLevelRaf != null) return
  _micLevelRaf = requestAnimationFrame(() => {
    _micLevelRaf = null
    _micLevel = Math.max(_micLevelPending, _micLevel * 0.72)
    paintMicLevel()
    const audible = _recording && (_micAudible ? _micLevel >= 0.02 : _micLevel >= 0.035)
    if (audible !== _micAudible) {
      _micAudible = audible
      _voiceHealthLabel = audible && voiceCanReportRawAudioFlowing() ? 'speech detected' : liveLivenessLabel()
      if (_recording) showRecordingHud()
      else showHud('off', '#9370db')
    }
  })
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
  paintMicLevel()
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
  paintMicLevel()
  setTextareaGlow(GLOW_AMBER)
}

// Show amber dot immediately (recording started, no audio yet)
function dotRecordingStart() {
  _voiceHealthLabel = 'starting voice'
  paintMicLevel()
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
  paintMicLevel()
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
  if (_backend === 'deepgram') return deepgramHealthLabel()
  if (_backend === 'whisper-stream') return 'mic live; waiting for speech'
  return 'mic live'
}

function runVoiceLivenessWatchdog() {
  if (!_recording) return
  showVoiceLiveness(voiceLivenessStatus(), liveLivenessLabel())
  // Computing the word honestly isn't enough on its own — the HUD only re-renders on
  // events, and the events that go quiet are exactly the ones that mean trouble. So
  // re-render whenever the true word changes. Bounded at 1 Hz and gated on an actual
  // change, so a stable state never repaints: the word can be wrong for at most a
  // second, and it cannot sit there lying while nothing happens to wake it.
  const word = voiceStatusLabel()
  if (word !== _lastStatusWord) {
    _lastStatusWord = word
    showRecordingHud()
  }
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
  if (_hud) {
    setMicInputLevel(0)
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
  if (!_deepgramWs || _deepgramWs.readyState !== WebSocket.OPEN || !_deepgramRelayConnected || _backend !== 'deepgram') return
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
  if (_backend !== 'deepgram' || !_recording) return false
  if (!voiceHasRoute() || (typeof document !== 'undefined' && document.hidden)) return false
  if (_deepgramWs?.readyState === WebSocket.OPEN && _deepgramRelayConnected) reconcileUpstream()
  if (_dgUpstreamPaused) return false
  if (_deepgramPcmPaused || !_deepgramWs || _deepgramWs.readyState !== WebSocket.OPEN ||
      !_deepgramRelayConnected || !deepgramRecognizerAcceptsAudio() || _deepgramReadyEpoch !== _speechEpoch) {
    _deepgramAudioBacklog.push(_speechEpoch, data)
    return true
  }
  try {
    _deepgramWs.send(data)
  } catch (err) {
    console.warn('voice: deepgram audio send failed', err)
    _deepgramAudioBacklog.push(_speechEpoch, data)
    return true
  }
  const now = Date.now()
  _audioChunkCadenceMs = _lastAudioChunkTime ? now - _lastAudioChunkTime : null
  _lastAudioChunkTime = now
  return true
}

function flushDeepgramAudioBacklog() {
  if (!_deepgramWs || !deepgramRecognizerConnected() || _deepgramReadyEpoch !== _speechEpoch) return false
  const relay = _deepgramWs
  const drained = _deepgramAudioBacklog.drain(_speechEpoch, chunk => {
    if (relay !== _deepgramWs || relay.readyState !== WebSocket.OPEN) return false
    try { relay.send(chunk); return true } catch { return false }
  })
  if (drained) {
    const now = Date.now()
    _audioChunkCadenceMs = _lastAudioChunkTime ? now - _lastAudioChunkTime : null
    _lastAudioChunkTime = now
  }
  return drained
}

function showHud(text, stateColor) {
  const hud = ensureHud()
  positionHud(hud)
  clearTimeout(_fadeTimer)
  // Build HUD content with text. Radio subtitle, when active, is
  // a second line in the same quiet plaque rather than a separate chat panel.
  hud.textContent = ''
  hud.style.display = 'flex'
  hud.style.alignItems = _radioExpanded && _radioSubtitle ? 'stretch' : 'center'
  hud.style.flexDirection = 'column'
  const radioLayout = _radioExpanded && _radioSubtitle ? radioHudPageLayout() : null
  hud.style.width = radioLayout ? `${radioLayout.width}px` : VOICE_HUD_WIDTH
  hud.style.left = '50%'
  hud.style.padding = _radioExpanded && _radioSubtitle ? '7px 12px' : '3px 10px'
  const statusRow = document.createElement('div')
  Object.assign(statusRow.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '0',
    overflow: 'hidden',
    width: VOICE_HUD_WIDTH,
    alignSelf: 'center',
  })
  statusRow.dataset.voiceState = voiceIndicatorState(_recording, _voiceHealthLabel)
  statusRow.setAttribute('aria-label', `Voice ${statusRow.dataset.voiceState}`)
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
  const phone = document.body?.classList?.contains('phone-mode')
  if (_radioExpanded && _radioSubtitle) {
    const line = document.createElement('div')
    line.textContent = _radioSubtitle.text
    Object.assign(line.style, {
      marginTop: '2px',
      minWidth: '0',
      overflow: 'hidden',
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: '6',
      whiteSpace: 'normal',
      wordBreak: 'break-word',
      color: 'rgba(255,255,255,0.82)',
      fontSize: '13px',
      lineHeight: '1.35',
      textAlign: 'left',
      width: '100%',
    })
    hud.appendChild(line)
    const prior = _radioHistory.slice(1)
    if (prior.length) {
      const trace = document.createElement('div')
      Object.assign(trace.style, {
        marginTop: '3px',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '1px',
      })
      for (const item of prior) {
        const row = document.createElement('div')
        row.textContent = `${item.label}: ${item.text}`
        Object.assign(row.style, {
          minWidth: '0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'rgba(255,255,255,0.42)',
          fontSize: '10px',
          lineHeight: '1.2',
          textAlign: 'left',
        })
        trace.appendChild(row)
      }
      hud.appendChild(trace)
    }
  }
  // The status row is the stable spatial anchor. Desktop plaques grow upward
  // from the bottom, phone plaques downward from the top.
  if (phone) hud.prepend(statusRow)
  else hud.appendChild(statusRow)
  hud.style.color = activeAgentColor() || stateColor || 'rgba(255,255,255,0.7)'
  paintMicLevel()
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

// Is a transcript actually coming back right now? This is the honest "receiving"
// signal — it means the whole chain answered, not that the microphone heard something.
// Damped by AUDIO_FLOWING_MS, so it can't flutter at syllable rate.
function receivingRecently(now = Date.now()) {
  return !!_lastResultTime && (now - _lastResultTime) < AUDIO_FLOWING_MS
}

// Show recording status — text uses agent color, dot shows health separately.
//
// THE WORD HAS TO BE TRUE. It used to read only `_voiceHealthLabel`, which is a cached
// string with several writers and no single recompute path — so when the chain died,
// nothing refreshed it and the HUD kept saying `mic live`. Measured 2026-07-25: 133
// Deepgram redials in 80 minutes, and the status word did not change once. Skip's own
// rule — a cache is a second copy of the truth that drifts; compute it instead.
//
// The lie only ran one way: the cache went stale *healthy* while the chain was down. A
// cached UNHEALTHY value is a real event worth showing (transient things like
// 'restarting voice' or a showDontSpeak reason live only there). So unhealthy from
// either source wins, and reporting healthy requires the live chain check and the
// cached label to agree.
function voiceStatusLabel() {
  if (!_recording) return 'off'
  const cached = voiceIndicatorState(true, _voiceHealthLabel)   // transient events
  const live = voiceIndicatorState(true, liveLivenessLabel())   // live chain state, recomputed now
  if (cached === 'reconnecting' || live === 'reconnecting') return 'reconnecting'
  // The audio gate itself. This is the predicate the audio path already trusts to decide
  // whether to send or backlog (see sendDeepgramAudioChunk), and it is the term that was
  // false during every one of the 133 redials — `_deepgramReadyEpoch !== _speechEpoch`
  // for the whole window his words were going into a buffer. Reusing it rather than
  // inventing a second health notion that can disagree with the one the audio obeys.
  if (_backend === 'deepgram' && !voiceCanReportRawAudioFlowing()) return 'reconnecting'
  // Everything above is a readiness claim from our own side: socket up, bridge says
  // connected, gate open. All of it can stay true while Deepgram silently stops
  // answering. So one end-to-end check the readiness terms cannot give — he is audibly
  // talking and nothing has come back for a long time. Gated on mic level so ordinary
  // silence never trips it, and held at 2x the flowing window so it can't flutter.
  if (_micAudible && _lastResultTime && Date.now() - _lastResultTime > AUDIO_FLOWING_MS * 2) return 'reconnecting'
  return receivingRecently() ? 'speaking' : 'mic live'
}

function showRecordingHud() {
  const who = targetLabel() || 'nowhere'
  const mode = _mathMode ? ' [math]' : ''
  const text = `${voiceStatusLabel()} -> ${who}${mode}`
  showHud(text, '#c87070')
}

function hideHud() {
  clearTimeout(_fadeTimer)
  if (_initialized) {
    if (_recording) showRecordingHud()
    else showHud('off', '#9370db')
    return
  }
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
function currentVoiceCompositionText() {
  return `${_left || ''}${_interim || ''}${_right || ''}`
}

function describeEditTrigger(trigger) {
  if (!trigger || typeof trigger === 'string') {
    return { origin: trigger || 'unknown', inputTrusted: null }
  }
  const origin = trigger.type || 'unknown'
  const inputTrusted = origin === 'input' ? trigger.isTrusted === true : null
  return { origin, inputTrusted }
}

function isDownstreamInputDuringSpeech(trigger) {
  return _backend === 'deepgram' &&
    _state === 'speech' &&
    trigger &&
    typeof trigger !== 'string' &&
    trigger.type === 'input' &&
    trigger.isTrusted === false
}

// Previous value of _left, so a write that shortens or rewrites COMMITTED text can be
// told apart from ordinary interim revision. Committed words must only grow or be
// deliberately cleared.
let _asmPrevLeft = ''

// Short tail of a string — enough to see a repeated segment without putting whole
// sentences of Skip's dictation in the log.
function vtail(s, n = 48) {
  const str = String(s ?? '')
  return str.length > n ? '…' + str.slice(-n) : str
}

function enterEdit(trigger = 'unknown') {
  if (_state === 'edit') return
  const { origin, inputTrusted } = describeEditTrigger(trigger)
  // ASSEMBLY INSTRUMENT. A speech→edit transition mid-dictation is the suspected
  // doubling engine: it clears _left/_interim/_right, and the next final then takes
  // the `_state !== 'speech'` branch, re-partitions _left from the text ALREADY
  // DISPLAYED, and appends the same words a second time. Record the transition and
  // whether the composition-equality guard below held, because that guard is the only
  // thing standing between an interim echo and a duplicated segment.
  if (_backend === 'deepgram' && _state === 'speech') {
    const value = _activeTextarea?.value
    const composition = currentVoiceCompositionText()
    vlog('assembly: enterEdit during speech', {
      origin,
      guardHolds: isDownstreamInputDuringSpeech(trigger),
      inputTrusted,
      valueMatchesComposition: value === composition,
      valueTail: vtail(value),
      compositionTail: vtail(composition),
      leftLen: (_left || '').length,
      interimLen: (_interim || '').length,
    })
  }
  // Deepgram voice writes already dispatch a synthetic textarea `input` event,
  // and React/downstream code can re-emit one after `_filling` has dropped.
  // Do not infer authorship from text equality here: punctuation, autocorrect,
  // or an empty field can make the DOM differ from the voice buffers while the
  // event is still downstream of our own write. Browser-trusted `input` events
  // are user edits and interrupt speech; untrusted ones are programmatic echoes.
  if (isDownstreamInputDuringSpeech(trigger)) {
    return
  }
  // Whisper-stream: flush the bridge — drops old audio output for ~4s
  // so text the user just edited doesn't get overwritten.
  // Show amber glow so user knows voice is suppressed.
  if (_backend === 'whisper-stream') {
    whisperLog(`enterEdit — flushing, gen=${_speechEpoch}`)
    flushWhisperBridge()
    setTextareaGlow(GLOW_AMBER)
  }
  if (_backend === 'deepgram') {
    _dgTrickleFlush()
    _deepgramInterim = ''
    _dgTrickleWords = []
    _dgTrickleShown = 0
    setTextareaGlow(GLOW_AMBER)
    _state = 'edit'
    _left = _interim = _right = ''
    return
  }
  _state = 'edit'
  advanceSpeechEpoch()
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
  _voiceDumping = false
  // A textarea target and an accumulator are alternatives, never both: fillTextarea
  // and targetLabel both consult the accumulator FIRST, so leaving one set here
  // welded voice to it. setVoiceAccumulator already enforces this in the other
  // direction (it nulls _activeTextarea); this side never did, which made a voice
  // note a one-way door — tapping into a chat composer set _activeTextarea, the
  // note's accumulator survived, and dictation kept landing in the note with the
  // HUD still reading "note". The only escape was reloading the app.
  _accumulator = null
  if (textarea !== _activeTextarea) {
    const wasRecording = _recording
    vlog('setVoiceTarget: switching chat', { wasRecording, backend: _backend, wsOpen: _deepgramRelayConnected, hasMic: !!_deepgramStream })
    if (_backend === 'whisper-stream') flushWhisperBridge()
    // Remove old listeners
    if (_inputListeners && _activeTextarea) {
      _activeTextarea.removeEventListener('input', _inputListeners.input)
      _activeTextarea.removeEventListener('click', _inputListeners.click)
      _activeTextarea.removeEventListener('keydown', _inputListeners.keydown, true)
      _inputListeners = null
    }
    _state = 'edit'
    advanceSpeechEpoch()
    _left = _interim = _right = ''
    if (_backend === 'deepgram') {
      resetDeepgramTextState({ ignoreUntilUtteranceEnd: true })
      if (wasRecording && _deepgramWs?.readyState === WebSocket.OPEN) {
        _deepgramPcmPaused = false
        _deepgramReadyEpoch = null
        _deepgramRecognizerStatus = null
        try {
          _deepgramWs.send(JSON.stringify({ type: 'speech_epoch', epoch: _speechEpoch }))
        } catch (err) {
          _deepgramPcmPaused = true
          _deepgramRecoveringEpoch = _speechEpoch
          console.warn('voice: target-switch epoch control failed', err)
          showDontSpeak('recognizer unavailable; recovering')
        }
      }
    }
    if (textarea) {
      const onEdit = (event) => { if (!_filling) enterEdit(event || 'unknown') }
      const onKeydown = (e) => {
        if (_filling) return
        if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) {
          enterEdit()
        }
      }
      textarea.addEventListener('input', onEdit)
      textarea.addEventListener('click', onEdit)
      textarea.addEventListener('keydown', onKeydown, true)
      _inputListeners = { input: onEdit, click: onEdit, keydown: onKeydown }
    }
  }
  _activeTextarea = textarea
  _activeTargetHandle = targetHandle || null
  // Prime the always-present transparent ring so the first record-start is a
  // colour-only transition, not a 0→2px geometry pop (see setTextareaGlow).
  if (textarea && !textarea.style.boxShadow) textarea.style.boxShadow = '0 0 0 2px transparent'
  if (_recording) {
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
  advanceSpeechEpoch()
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

// True when voice is routed to a live textarea or accumulator and NOT dumping
// to nowhere. Streaming to Deepgram is
// gated on this so "recording to nowhere" / dumb mode never bills.
function voiceHasRoute() {
  return !_voiceDumping && (_activeTextarea?.isConnected === true || !!_accumulator)
}

export function getVoiceRuntimeSummary(now = Date.now()) {
  const deepgramBacklog = _deepgramAudioBacklog.snapshot(now)
  return {
    backend: _backend,
    recording: _recording,
    state: _state,
    healthLabel: _voiceHealthLabel || null,
    liveness: voiceLivenessStatus(now),
    hasRoute: voiceHasRoute(),
    targetLabel: targetLabel(),
    voiceDumping: _voiceDumping,
    hasTextarea: !!_activeTextarea,
    hasAccumulator: !!_accumulator,
    activeSendTargetCount: activeSendTargets().length,
    generation: _speechEpoch,
    editStopped: _editStopped,
    deepgram: {
      relayConnected: _deepgramRelayConnected,
      recognizerStatus: currentDeepgramRecognizerStatus(),
      recognizerConnected: deepgramRecognizerConnected(),
      commonState: deepgramCommonState(now),
      available: _deepgramAvailable,
      wsReadyState: _deepgramWs?.readyState ?? null,
      wsBufferedAmount: _deepgramWs?.bufferedAmount ?? null,
      hasMicStream: !!_deepgramStream,
      audioContextState: _deepgramContext?.state ?? null,
      upstreamPaused: _dgUpstreamPaused,
      micFrameCadenceMs: _micFrameCadenceMs,
      audioChunkCadenceMs: _audioChunkCadenceMs,
      lastMicFrameAgoMs: _lastMicFrameTime ? now - _lastMicFrameTime : null,
      lastAudioChunkAgoMs: _lastAudioChunkTime ? now - _lastAudioChunkTime : null,
      audioBacklogFrames: deepgramBacklog.frames,
      audioBacklogBytes: deepgramBacklog.bytes,
      audioBacklogOldestAgeMs: deepgramBacklog.oldestAgeMs,
      droppedAudioFrames: deepgramBacklog.droppedFrames,
      flushedAudioFrames: deepgramBacklog.flushedFrames,
      proxy: _lastProxyTelemetry,
      bridge: _lastBridgeTelemetry,
    },
    chrome: {
      recognizerActive: !!_recognition,
      speechRecognitionAvailable: !!SpeechRecognition,
    },
    whisper: {
      connected: _whisperConnected,
      available: _whisperAvailable,
      wsReadyState: _whisperWs?.readyState ?? null,
      wsBufferedAmount: _whisperWs?.bufferedAmount ?? null,
      lastMessageAgoMs: _lastWhisperMessageTime ? now - _lastWhisperMessageTime : null,
    },
    lastResultAgoMs: _lastResultTime ? now - _lastResultTime : null,
    recentLogCount: _voiceLogs.length,
    documentHidden: typeof document !== 'undefined' ? document.hidden : null,
  }
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
  // metric, not info: log.info is gated at the default `warn` threshold, so this
  // never reached client.log in a normal session — the measurement it exists for
  // was not being taken.
  log.metric('voice', 'first-interim', {
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
  if (!ta) {
    // No accumulator and no textarea: the transcript has nowhere to land and is
    // dropped here with no trace. `_left` keeps growing but the next epoch advance
    // erases it, so these words are gone.
    vdiscard('no-target', 'DROPPED transcript (no target to write to)', {
      targetLabel: targetLabel(), pending: String(text || '').slice(0, 40), state: _state,
    })
    return
  }
  _filling = true
  const receipt = deliverVoiceComposition(ta, { left: _left, interim: _interim, right: _right }, (liveTextarea, nextText) => {
    liveTextarea.value = nextText
    liveTextarea.style.height = 'auto'
    liveTextarea.style.height = Math.min(liveTextarea.scrollHeight, 200) + 'px'
    // Restore cursor to end of voice portion (between interim and right)
    if (_state === 'speech' && _right.length > 0) {
      const cursorPos = nextText.length - _right.length
      liveTextarea.setSelectionRange(cursorPos, cursorPos)
    }
    liveTextarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  _filling = false
  if (!receipt.written) vlog('transcript not written', { target: targetLabel(), ...receipt })

  // THE VANISHING. Skip: "I was just trying to talk, and it just kept vanishing on me."
  // Nothing recorded the one thing that says literally: the composer got SHORTER. The
  // receipt already carries the before/after lengths, so this costs a comparison.
  //
  // A shrinking DISPLAY is not automatically a fault — Deepgram revises an interim to
  // something shorter routinely, and that is the trickle working. Committed text is
  // different: once words are in `_left` they are his, and `_left` must only ever grow
  // or be deliberately cleared. So the two are recorded separately, and only the second
  // is a violation.
  const prevLeft = _asmPrevLeft
  _asmPrevLeft = _left || ''
  // Deliberate clears (send, epoch advance, reset) empty _left and are recorded at their
  // own sites; excluding them keeps this signal specific to words going missing.
  // trimEnd on the previous value, not cosmetics: the re-partition branch re-seeds _left
  // from the textarea, which can differ from the buffer by trailing whitespace. Tested —
  // the strict form reports that as lost words, and a detector that cries vanishing when
  // nothing vanished is worse than no detector.
  const committedLost = !!prevLeft && !!_left && !String(_left).startsWith(prevLeft.trimEnd())
  if (committedLost) {
    // Never throttled: committed text disappearing is the reported symptom itself.
    vlog('COMMITTED TEXT LOST (left no longer extends its previous value)', {
      prevLeftLen: prevLeft.length, leftLen: _left.length,
      prevLeftTail: vtail(prevLeft), leftTail: vtail(_left),
      state: _state, target: targetLabel(),
    })
  } else if (receipt.afterLength < receipt.beforeLength) {
    vdiscard('composer-shrank', 'composer text got shorter', {
      before: receipt.beforeLength, after: receipt.afterLength,
      leftLen: (_left || '').length, interimLen: (_interim || '').length, state: _state,
    })
  }

  if (!receipt.connectedBefore && _activeTextarea === ta) clearVoiceTarget(ta)
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

function startChromeAfterUnexpectedStop(myEpoch, dropStartedAt) {
  if (!_recording || _backend !== 'chrome' || _speechEpoch !== myEpoch) return
  if (_chromeUnexpectedRestartFailures >= CHROME_UNEXPECTED_RESTART_LIMIT) {
    stopRecording()
    showHud('mic failed — tap to resume', '#c87070')
    fadeHud(5000)
    return
  }
  _chromeUnexpectedRestartFailures++
  if (_speechEpoch === myEpoch) _setupRecognition()
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
    const retryOwner = _recognition
    setTimeout(() => {
      if (!_recording || _backend !== 'chrome' || _speechEpoch !== myEpoch || _recognition !== retryOwner) return
      try {
        showVoiceRestarting('speech recognition invalid-state retry')
        _recognition.start()
        insertChromeMissingnessMarker(dropStartedAt)
        markVoiceRestarted()
      } catch {
        startChromeAfterUnexpectedStop(myEpoch, dropStartedAt)
      }
    }, 100)
  }
}

// --- Speech Recognition ---

function _setupRecognition() {
  // Snapshot the generation at setup time. Any onresult that arrives after
  // _speechEpoch has been bumped (send, chat-switch, target-change, start) is
  // from a stale session and will be discarded before touching the textarea.
  const myEpoch = _speechEpoch

  _recognition = new SpeechRecognition()
  const myRecognition = _recognition
  const ownerIsCurrent = () => _speechEpoch === myEpoch && _recognition === myRecognition
  const ownedTimeout = (callback, delay) => setTimeout(() => {
    if (!ownerIsCurrent()) return
    callback()
  }, delay)
  _recognition.continuous = true
  _recognition.interimResults = true
  _recognition.lang = 'en-US'

  _recognition.onresult = (e) => {
    // Discard results from a stale session (generation bumped since setup).
    if (_speechEpoch !== myEpoch || _recognition !== myRecognition) return

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
          advanceSpeechEpoch()
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
    if (_speechEpoch !== myEpoch || _recognition !== myRecognition) return
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
        ownedTimeout(() => {
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
      navigator.mediaDevices.getUserMedia({ audio: true }).then(async stream => {
        stream.getTracks().forEach(t => t.stop())
        if (!_recording || !ownerIsCurrent()) return
        _setupRecognition()
        try {
          showVoiceRestarting('permission retry')
          _recognition.start()
          markVoiceRestarted()
          showRecordingHud()
        } catch (err) {
          console.warn('voice: not-allowed retry failed', err)
          const failure = await classifyMicFailure(err, 'recognition-start')
          if (!_recording || !ownerIsCurrent()) return
          stopRecording()
          showHud(failure.label, '#c87070')
          fadeHud(5000)
        }
      }).catch(async err => {
        const failure = await classifyMicFailure(err)
        if (!_recording || !ownerIsCurrent()) return
        stopRecording()
        showHud(failure.label, '#c87070')
        fadeHud(5000)
      })
      return
    }
    if (_recording && e.error === 'network') {
      showHud('mic error — retrying…', '#c8956a')
      ownedTimeout(() => {
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
          if (!_recording || !ownerIsCurrent()) return
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
          if (!ownerIsCurrent()) return
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
    if (_recognition !== myRecognition) return
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
        startChromeAfterUnexpectedStop(myEpoch, dropStartedAt)
        return
      }
      // If generation was bumped since this session was set up (e.g. chat-switch
      // or send keyword called _speechEpoch++ before our stop() triggered onend),
      // create a new SpeechRecognition object so its onresult closure captures
      // the current _speechEpoch. Without this, the restarted session would still
      // have the old myEpoch snapshot and discard every result it receives.
      if (_speechEpoch !== myEpoch) {
        _setupRecognition()
      }
      try {
        showVoiceRestarting('speech recognition onend')
        _recognition.start()
        markVoiceRestarted()
      } catch (err) {
        if (err.name !== 'InvalidStateError') throw err
        const retryOwner = _recognition
        const retryEpoch = _speechEpoch
        setTimeout(() => {
          if (!_recording || _speechEpoch !== retryEpoch || _recognition !== retryOwner) return
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
        advanceSpeechEpoch()
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
let _deepgramReconnectTimer = null
let _deepgramRelayGeneration = 0
let _deepgramRelayConnected = false
let _deepgramRecognizerStatus = null // authoritative connected|idle|error from the bridge
let _deepgramRecognizerRelay = null  // relay socket that delivered the status
let _deepgramHardFailure = null      // explicit local nonrecoverable evidence only
let _deepgramMicAttempt = 0          // exact owner of async mic-start publication
let _deepgramPcmPaused = false
let _deepgramRecoveringEpoch = null
let _deepgramReadyEpoch = null
const _deepgramAudioBacklog = new PcmBacklog()
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
let _dgTrickleEpoch = 0
let _dgTrickleDelay = 40         // ms between words (adjusted per burst)
let _dgIgnoreUntilUtteranceEnd = false // true after voice-send; drops trailing old-utterance results
let _dgIgnoredSubmittedText = null // normalized utterance submitted before waiting for utterance_end
let _dgLastFinalNorm = ''        // last committed final; used to drop duplicate stale finals
let _dgLastFinalAt = 0           // timestamp for same-final echo suppression
const DEEPGRAM_REPEAT_ECHO_WINDOW_MS = 1200
let _micFrameCadenceMs = null
let _audioChunkCadenceMs = null
let _lastProxyTelemetry = null
let _lastBridgeTelemetry = null

function currentDeepgramRecognizerStatus() {
  return _deepgramRelayConnected && _deepgramRecognizerRelay === _deepgramWs
    ? _deepgramRecognizerStatus
    : null
}

function deepgramRecognizerConnected() {
  return currentDeepgramRecognizerStatus() === 'connected'
}

// Whether the bridge will do something useful with an audio frame right now.
// Wider than `connected` by exactly one state, and the difference is the whole
// bug behind "a disconnect that won't be resolved on its own":
//
// After IDLE_CUTOFF_MS with no speech the bridge closes its upstream, sets
// `idleClosed`, and reports `status:'idle'`. Its ONLY way back is an inbound
// frame whose RMS clears `resumeRms` — see the `if (idleClosed)` resume in
// deepgram-sdk-bridge.mjs. So while it is idle it is not deaf; it is listening
// for exactly one thing. Gating our send on `connected` withheld that one thing
// and parked his speech in the backlog, which prunes at 3s: the frame the bridge
// was waiting for was the frame we had decided not to send, both sides waited
// forever, and only a fresh `start` from the mic button broke the tie.
//
// 'error' stays excluded on purpose — that upstream is not idle-closed and does
// not resume on audio, so it has its own reconnect and frames would be wasted.
function deepgramRecognizerAcceptsAudio() {
  const status = currentDeepgramRecognizerStatus()
  return status === 'connected' || status === 'idle'
}

function deepgramCommonState(now = Date.now()) {
  if (!_recording || _backend !== 'deepgram') return 'inactive'
  if (_deepgramHardFailure) return 'failed'
  if (!_deepgramRelayConnected) {
    return _deepgramWs?.readyState === WebSocket.CONNECTING ? 'starting' : 'recovering'
  }
  const status = currentDeepgramRecognizerStatus()
  if (status === 'connected') return voiceLivenessStatus(now) === 'live' ? 'usable' : 'recovering'
  // Idle is not a fault and nothing needs to recover from it: the upstream is
  // closed to conserve a quiet mic, we keep streaming, and the bridge reopens on
  // his first words (with pre-roll, so they aren't clipped). Reporting
  // 'recovering' here described a repair that was never happening.
  if (status === 'idle') return 'usable'
  if (status === 'error') return 'recovering'
  return 'starting'
}

function deepgramHealthLabel(now = Date.now()) {
  if (_deepgramHardFailure) return _deepgramHardFailure
  if (!_deepgramRelayConnected) {
    return _deepgramWs?.readyState === WebSocket.CONNECTING
      ? 'connecting to recognizer'
      : 'connection lost; reconnecting'
  }
  const status = currentDeepgramRecognizerStatus()
  if (status === 'connected') {
    return voiceLivenessStatus(now) === 'live' ? 'mic live; waiting for speech' : 'no mic input'
  }
  if (status === 'idle') return 'paused; speak to resume'
  if (status === 'error') return 'recognizer unavailable; recovering'
  return 'waiting for recognizer'
}

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

function deepgramWordTokens(text) {
  const tokens = []
  const re = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g
  const source = String(text || '')
  for (const match of source.matchAll(re)) {
    tokens.push({
      norm: normalizeDeepgramText(match[0]),
      end: match.index + match[0].length,
    })
  }
  return tokens.filter(token => token.norm)
}

function trimSubmittedPrefixFromDeepgramText(text, submittedNorm) {
  const submitted = String(submittedNorm || '').trim()
  if (!submitted) return { text, droppedWords: 0 }
  const incomingWords = deepgramWordTokens(text)
  let overlap = 0
  for (let n = incomingWords.length; n > 0; n--) {
    const incomingPrefix = incomingWords.slice(0, n).map(token => token.norm).join(' ')
    if (submitted.endsWith(incomingPrefix)) {
      overlap = n
      break
    }
  }
  if (overlap === 0) return { text, droppedWords: 0 }
  if (overlap >= incomingWords.length) return { text: '', droppedWords: overlap }
  return {
    text: String(text || '').slice(incomingWords[overlap - 1].end).replace(/^[\s,.;:!?-]+/, ''),
    droppedWords: overlap,
  }
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

function submitTextareaViaMagicWord(cleanText, submittedText) {
  if (!_activeTextarea || activeSendTargets().length === 0) return false
  if (_activeTargetHandle?.submitCurrent) {
    replaceTextareaValue(cleanText)
    return _activeTargetHandle.submitCurrent()
  }
  if (!_activeTargetHandle?.sendVoice) return false
  _activeTargetHandle.sendVoice(activeSendTargets(), cleanText)
  replaceTextareaValue('')
  afterSend(submittedText)
  return true
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
    return submitTextareaViaMagicWord(cleanText, leftTrimmed)
  }

  // He finished a sentence and said the send word with nothing focused. afterSend()
  // is about to erase _left/_interim/_right, so this line is the only surviving copy
  // of what he said. Recording it is a stopgap, not the answer — the text still is not
  // retrievable from the UI, which is the open proposal.
  vlog('DESTROYED speech (send word with no target)', { text: leftTrimmed })
  showHud('no chat focused', '#c8956a')
  fadeHud(2000)
  afterSend()
  if (_backend === 'deepgram') resetDeepgramTextState({ ignoreUntilUtteranceEnd: true, submittedText: leftTrimmed })
  return true
}

function scheduleDgTrickle(epoch) {
  const timer = setTimeout(() => _dgTrickleStep(timer, epoch), _dgTrickleDelay)
  _dgTrickleTimer = timer
}

function _dgTrickleStep(timer, epoch) {
  if (_dgTrickleTimer !== timer) return
  _dgTrickleTimer = null
  if (epoch !== _speechEpoch) return
  if (_dgTrickleShown >= _dgTrickleWords.length) return
  _dgTrickleShown++
  _interim = postProcessTranscript(_dgTrickleWords.slice(0, _dgTrickleShown).join(' '))
  const display = _left + (_interim ? ' ' + _interim : '') + _right
  fillTextarea(display)
  if (_dgTrickleShown < _dgTrickleWords.length) {
    scheduleDgTrickle(epoch)
  }
}

function onDeepgramMessage(event, relay = _deepgramWs) {
  if (!_recording || _backend !== 'deepgram') {
    try {
      const m = JSON.parse(event.data)
      if (m.type === 'transcript' && m.text) vlog('DROPPED transcript (not recording)', { text: m.text.slice(0, 30) })
    } catch {}
    return
  }
  try {
    const msg = JSON.parse(event.data)

    if (msg.type === 'proxy_status') {
      if (relay !== _deepgramWs) return
      _lastProxyTelemetry = { ...(msg.proxy || {}), receivedAt: Date.now() }
      return
    }

    if (msg.type === 'bridge_telemetry') {
      if (relay !== _deepgramWs) return
      _lastBridgeTelemetry = { ...(msg.bridge || {}), receivedAt: Date.now() }
      return
    }

    if (msg.type === 'epoch_ready') {
      if (relay !== _deepgramWs || msg.epoch !== _speechEpoch) return
      _deepgramRecoveringEpoch = null
      _deepgramReadyEpoch = msg.epoch
      _deepgramPcmPaused = false
      _deepgramRecognizerStatus = 'connected'
      _deepgramRecognizerRelay = relay
      hideDontSpeak()
      showRecordingHud()
      flushDeepgramAudioBacklog()
      return
    }

    if (msg.type === 'epoch_loss' || msg.type === 'epoch_error') {
      if (relay !== _deepgramWs) return
      if (msg.type === 'epoch_loss' && msg.epoch !== _speechEpoch) {
        showDontSpeak('speech lost before send')
        return
      }
      if (msg.epoch !== _speechEpoch) return
      _deepgramPcmPaused = true
      _deepgramRecoveringEpoch = msg.epoch
      _deepgramRecognizerStatus = 'error'
      _deepgramRecognizerRelay = relay
      showDontSpeak(msg.type === 'epoch_loss' ? 'speech lost; recognizer recovering' : 'recognizer unavailable; recovering')
      if (msg.type === 'epoch_loss') {
        try {
          relay.send(JSON.stringify({ ...JSON.parse(dgStartMsg()), epoch: msg.epoch }))
        } catch (err) {
          console.warn('voice: same-epoch recovery start failed', err)
        }
      }
      return
    }

    // THE CARRIED TAIL. The bridge deliberately stamps results describing audio he spoke
    // BEFORE a send with the epoch he was on BEFORE it (`carriedEpoch`,
    // deepgram-sdk-bridge.mjs:advanceEpochOnLiveSocket). Its comment states the intent
    // plainly: the tail "is already handled, content-first, on the client: after a send
    // it holds _dgIgnoredSubmittedText and drops any result matching the text it just
    // sent, releasing on the first result that doesn't match."
    //
    // That content guard never gets to run. This epoch check sits above it and discards
    // the carried result first — so the two halves of one design disagree, and the words
    // he spoke just before hitting send are destroyed. Observed 2026-07-25: "Never
    // finalized anything." came back stamped epoch 93 while the client was on 94, was
    // dropped here, and was absent from the message he actually sent.
    //
    // So: at the send boundary only, let a final from the immediately-preceding epoch
    // reach the guard that was designed to judge it. The guard is content-based — it
    // drops anything matching what was just sent and releases on genuinely new words —
    // so a duplicate tail still cannot leak, and only words that were never delivered
    // survive. `_dgIgnoreUntilUtteranceEnd` is set only by a send, which confines this
    // to exactly the moment the bridge carries the epoch; any other reason for an epoch
    // change (target switch, stop) leaves it false and old results stay stale.
    //
    // NOT keyed on `from_finalize`, deliberately: the bridge comment records only 22 of
    // those in an entire log against ordinary is_final crossings being the common case,
    // so keying on it would fix the observed instance and miss the general one.
    const isCarriedTail = msg.type === 'transcript' && !!msg.text && !!msg.is_final &&
      _dgIgnoreUntilUtteranceEnd && msg.epoch === _speechEpoch - 1
    if (isCarriedTail) {
      vlog('carried tail accepted (previous epoch, send boundary)', {
        msgEpoch: msg.epoch, speechEpoch: _speechEpoch,
        fromFinalize: !!msg.from_finalize, text: vtail(msg.text, 60),
      })
    }
    if (!isCarriedTail &&
        (msg.type === 'transcript' || msg.type === 'speech_started' || msg.type === 'utterance_end') && msg.epoch !== _speechEpoch) {
      // Speech dies here with no trace. Recording it is the whole point: an epoch
      // mismatch on a *transcript* means words came back and were thrown away.
      if (msg.type === 'transcript' && msg.text) {
        // WAS ANYTHING ACTUALLY LOST? A dropped final is only a spec violation if those
        // words never reached him. The obvious check — is the text already in `_left` —
        // is useless here: the epoch only advances via afterSend(), which has already
        // cleared _left/_interim/_right by the time this stale transcript arrives, so
        // _left is always empty at this point and would always read "lost".
        //
        // `_dgIgnoredSubmittedText` is the normalized text of the message that was just
        // sent, which is the thing to compare against: if the dropped words are inside
        // it, they reached him and nothing was lost. Null when the epoch moved for a
        // reason other than a send (target switch, stop) — reported as unknown rather
        // than guessed either way.
        const droppedNorm = normalizeDeepgramText(msg.text)
        const submitted = _dgIgnoredSubmittedText
        const alreadySent = submitted && droppedNorm ? submitted.includes(droppedNorm) : null
        const record = {
          msgEpoch: msg.epoch,
          speechEpoch: _speechEpoch,
          final: !!msg.is_final,
          text: msg.text.slice(0, 60),
          alreadySent,
          lost: alreadySent === false,
          submittedTail: vtail(submitted),
        }
        // Finals are never rate-limited. They are rare (4 in 11 minutes observed) and
        // each one is a candidate spec violation, so losing one to a throttle would
        // defeat the instrument — the earlier shared key already suppressed one and we
        // cannot tell whether it was a final. Interims are high-volume and repeat
        // themselves, so they keep the limiter.
        if (msg.is_final) vlog('DROPPED transcript (epoch mismatch)', record)
        else vdiscard('epoch-mismatch-interim', 'DROPPED transcript (epoch mismatch)', record)
      }
      // utterance_end is a RELEASE SIGNAL, not a notification — it is one of only two
      // things that clear _dgIgnoreUntilUtteranceEnd, and while that guard is armed
      // every transcript overlapping the submitted text is dropped. The bridge stamps
      // it with activeEpoch at emit time, and the client arms the guard right AFTER
      // advancing the epoch, so a UtteranceEnd that races the epoch bump lands here
      // and strands the guard. Log it separately: losing this is not the same event as
      // losing a transcript, and it has to be greppable on its own.
      if (msg.type === 'utterance_end') {
        vdiscard('epoch-mismatch-utterance-end', 'DROPPED utterance_end (epoch mismatch) — guard may be stranded', {
          msgEpoch: msg.epoch, speechEpoch: _speechEpoch, guardArmed: _dgIgnoreUntilUtteranceEnd,
        })
      }
      // The last silent return in this block. `speech_started` is not a notification
      // either: its handler resets _lastResultTime and clears the final-dedup state, so
      // dropping it means the client never learns he began speaking — the liveness word
      // keeps ageing and the next final can be mistaken for a duplicate. It is also the
      // only one of the three whose loss is invisible in the existing analysis: a stall
      // run is DEFINED by lastResultMs climbing, and a processed speech_started resets
      // that clock, so a dropped one cannot be distinguished from one that never came.
      if (msg.type === 'speech_started') {
        vdiscard('epoch-mismatch-speech-started', 'DROPPED speech_started (epoch mismatch)', {
          msgEpoch: msg.epoch, speechEpoch: _speechEpoch,
        })
      }
      return
    }

    if (msg.type === 'status') {
      console.log('voice: deepgram status:', msg.status)
      if (relay !== _deepgramWs || !_deepgramRelayConnected) return
      if (msg.epoch !== _speechEpoch) return
      if (msg.status !== 'connected' && msg.status !== 'idle' && msg.status !== 'error') return
      if (msg.status === 'connected' && _deepgramReadyEpoch !== _speechEpoch) return
      _deepgramRecognizerStatus = msg.status
      _deepgramRecognizerRelay = relay
      if (msg.status === 'connected') {
        hideDontSpeak()
      } else {
        showDontSpeak(msg.status === 'idle' ? 'paused; speak to resume' : 'recognizer unavailable; recovering')
      }
      _voiceHealthLabel = deepgramHealthLabel()
      showRecordingHud()
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
      return
    }

    if (msg.type !== 'transcript' || !msg.text) return

    if (_dgIgnoreUntilUtteranceEnd) {
      const normalized = normalizeDeepgramText(msg.text)
      if (_dgIgnoredSubmittedText && (_dgIgnoredSubmittedText.includes(normalized) || normalized.includes(_dgIgnoredSubmittedText))) {
        vlog('DROPPED transcript (waiting for utterance end)', { final: !!msg.is_final, text: msg.text.slice(0, 30) })
        return
      }
      const trimmed = trimSubmittedPrefixFromDeepgramText(msg.text, _dgIgnoredSubmittedText)
      if (trimmed.droppedWords > 0) {
        if (!trimmed.text) {
          vlog('DROPPED transcript (submitted prefix consumed full carried result)', {
            final: !!msg.is_final,
            droppedWords: trimmed.droppedWords,
            text: msg.text.slice(0, 60),
          })
          return
        }
        vlog('trimmed submitted prefix from carried transcript', {
          final: !!msg.is_final,
          droppedWords: trimmed.droppedWords,
          original: msg.text.slice(0, 60),
          trimmed: trimmed.text.slice(0, 60),
        })
        msg.text = trimmed.text
      }
      vlog('released utterance-end guard on fresh transcript', { final: !!msg.is_final, text: msg.text.slice(0, 30) })
      _dgIgnoreUntilUtteranceEnd = false
      _dgIgnoredSubmittedText = null
    }

    _lastResultTime = Date.now()
    dotAudioFlowing()

    // ASSEMBLY INSTRUMENT — every transcript, before any buffer is touched. `speech_final`
    // is RECORDED ONLY, never branched on: `is_final=true, speech_final=false` means the
    // segment closed but the utterance continues, and whether we are wrongly committing
    // those is one of the two hypotheses. Reading it here changes no behaviour.
    const _asmStateBefore = _state
    const _asmLeftBefore = _left || ''
    vlog('assembly: transcript in', {
      final: !!msg.is_final,
      speechFinal: !!msg.speech_final,
      fromFinalize: !!msg.from_finalize,
      text: vtail(msg.text, 60),
      state: _asmStateBefore,
      hasSeenInterim: _dgHasSeenInterim,
      leftTail: vtail(_asmLeftBefore),
      interimTail: vtail(_interim),
      valueMatchesComposition: _activeTextarea?.value === currentVoiceCompositionText(),
    })

    if (_state !== 'speech') {
      _state = 'speech'
      const ta = _activeTextarea
      const partition = partitionAtCursor(ta?.value, ta?.selectionStart, ta?.selectionEnd)
      _left = partition.left
      _interim = partition.interim
      _right = partition.right
      resetDeepgramTextState()
      // THE SUSPECTED DOUBLING ENGINE. _left is re-seeded from what is already on
      // screen — which includes the interim words just displayed — and a final carrying
      // those same words is about to be appended to it. If `absorbedTail` ends with the
      // words in the incoming text, the next append duplicates them.
      vlog('assembly: re-partitioned from textarea', {
        stateWas: _asmStateBefore,
        absorbedTail: vtail(_left),
        incoming: vtail(msg.text, 60),
        final: !!msg.is_final,
      })
    }

    const text = msg.text

    // ⚠️ OPEN BUG LIVES HERE — read before patching. Skip, 2026-07-25: he received
    // "Cool. Cool. Okay. So Cool. Cool. Okay. So so what do we do?" and said "I didn't
    // say that shit twice." A segment repeats INSIDE one message.
    //
    // We branch on `is_final` alone. Deepgram also sends `speech_final`, and
    // `is_final=true, speech_final=false` means "this segment is closed, the utterance
    // continues" — a mid-sentence commit, not the end of what he's saying. **`voice.mjs`
    // never reads `speech_final` anywhere**, so a segment-final is committed exactly like
    // a sentence-final. Preserved specimen: bridge log, all at epoch=27.
    //
    // NOT the epoch carry — every line of the specimen is the same epoch, no advance —
    // and not new: this path is unchanged, it was just masked by the louder cross-message
    // leak until that was fixed.
    //
    // THE OBVIOUS FIX IS WRONG. "The final appends while the interim is still displayed"
    // is the natural reading and it does NOT reproduce the doubling: the branch below
    // appends to _left, then resetDeepgramTextState({preserveLastFinal:true}) clears
    // _deepgramInterim, _dgHasSeenInterim, _dgTrickleWords and _dgTrickleShown, and
    // `_interim = ''` follows. Walked by hand, the specimen yields ONE copy plus the
    // "So so" stutter — not two. Patch that story and the bug survives with a fix in
    // front of it.
    //
    // Leading unconfirmed hypothesis: a feedback loop through the textarea, not the
    // buffers. The interim path calls fillTextarea(), whose `input` listener runs
    // enterEdit() and re-partitions the field's current contents back into _left/_right,
    // guarded by `_filling`. A write reaching fillTextarea without that guard would
    // absorb the displayed interim into _left, and the arriving final would then append
    // the same words again — which matches the shape and explains why the buffer
    // arithmetic looks correct. UNVERIFIED.
    //
    // REPRODUCE THE DOUBLING BEFORE CHANGING A LINE.
    if (msg.is_final) {
      // Final result — append to committed text, clear interim
      _dgTrickleFlush()
      const processed = postProcessTranscript(text)
      const normalizedFinal = normalizeDeepgramText(processed)
      if (normalizedFinal && normalizedFinal === _dgLastFinalNorm && !_dgHasSeenInterim) {
        vlog('DROPPED transcript (duplicate final)', { text: text.slice(0, 30) })
        return
      }
      // ASSEMBLY INSTRUMENT — the append itself. `duplicateAppend` is the whole
      // question: it is true when _left ALREADY ends with the words we are about to
      // add, which is duplication happening at this line rather than anywhere else.
      // Computed on normalized text so punctuation and spacing can't hide it.
      const _asmLeftNorm = normalizeDeepgramText(_left || '')
      const _asmDuplicate = !!normalizedFinal && !!_asmLeftNorm && _asmLeftNorm.endsWith(normalizedFinal)
      vlog(_asmDuplicate ? 'assembly: DUPLICATE APPEND' : 'assembly: append final', {
        duplicateAppend: _asmDuplicate,
        stateAtEntry: _asmStateBefore,
        repartitioned: _asmStateBefore !== 'speech',
        speechFinal: !!msg.speech_final,
        appending: vtail(processed, 60),
        leftTailBefore: vtail(_left),
      })
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
          _dgTrickleEpoch = _speechEpoch
          scheduleDgTrickle(_speechEpoch)
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
        advanceSpeechEpoch()
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

function deepgramRelayAuthorityIsCurrent(generation) {
  return generation === _deepgramRelayGeneration && _recording && _backend === 'deepgram'
}

function invalidateDeepgramRelayAuthority() {
  _deepgramRelayGeneration++
  if (_deepgramReconnectTimer !== null) {
    clearTimeout(_deepgramReconnectTimer)
    _deepgramReconnectTimer = null
  }
}

function scheduleDeepgramReconnect(generation) {
  if (_deepgramReconnectTimer !== null || !deepgramRelayAuthorityIsCurrent(generation)) return
  const timer = setTimeout(() => {
    if (_deepgramReconnectTimer !== timer) return
    _deepgramReconnectTimer = null
    if (!deepgramRelayAuthorityIsCurrent(generation)) return
    connectDeepgramBridge(generation)
  }, 1000)
  _deepgramReconnectTimer = timer
}

function connectDeepgramBridge(generation) {
  if (!deepgramRelayAuthorityIsCurrent(generation)) return
  if (_deepgramWs && _deepgramWs.readyState === WebSocket.OPEN) return
  if (_deepgramWs) {
    _deepgramWs.onclose = null
    try { _deepgramWs.close() } catch {}
    _deepgramWs = null
  }
  try {
    _voiceHealthLabel = 'connecting to recognizer'
    if (_recording) showRecordingHud()
    const relay = new WebSocket(deepgramBridgeUrl())
    _deepgramWs = relay
    relay.onopen = () => {
      if (_deepgramWs !== relay || !deepgramRelayAuthorityIsCurrent(generation)) {
        if (_deepgramWs === relay) _deepgramWs = null
        relay.onclose = null
        relay.close()
        return
      }
      _deepgramRelayConnected = true
      _voiceHealthLabel = deepgramHealthLabel()
      showRecordingHud()
      vlog('bridge WS open')
      _dgUpstreamPaused = false   // fresh bridge session starts streaming
      relay.send(JSON.stringify({ type: 'speech_epoch', epoch: _speechEpoch }))
      relay.send(dgStartMsg())
    }
    relay.onmessage = (event) => onDeepgramMessage(event, relay)
    relay.onclose = () => {
      if (_deepgramWs !== relay) return
      _deepgramRelayConnected = false
      _deepgramWs = null
      vlog('bridge WS closed', { recording: _recording })
      showDontSpeak('connection lost; reconnecting')
      if (deepgramRelayAuthorityIsCurrent(generation)) {
        vlog('bridge auto-reconnect in 1s')
        scheduleDeepgramReconnect(generation)
      }
    }
    relay.onerror = (err) => { vlog('bridge WS error', { message: err?.message || 'unknown' }) }
  } catch {
    _deepgramWs = null
  }
}

function disconnectDeepgramBridge() {
  invalidateDeepgramRelayAuthority()
  stopDeepgramMic()
  if (_deepgramWs) {
    if (_deepgramRelayConnected) {
      try { _deepgramWs.send(JSON.stringify({ type: 'stop' })) } catch {}
    }
    _deepgramWs.onclose = null
    _deepgramWs.close()
    _deepgramWs = null
  }
  _deepgramRelayConnected = false
  if (!_recording) _deepgramAudioBacklog.clear()
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

  const micAttempt = ++_deepgramMicAttempt

  try {
    _deepgramStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
    })
    _deepgramHardFailure = null
  } catch (err) {
    console.error('voice: deepgram mic access failed', err)
    const failure = await classifyMicFailure(err)
    if (micAttempt !== _deepgramMicAttempt) return
    _deepgramHardFailure = failure.label
    _voiceHealthLabel = _deepgramHardFailure
    showHud(failure.label, '#c87070')
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
    _deepgramHardFailure = 'mic unavailable; tap to retry'
    _voiceHealthLabel = _deepgramHardFailure
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
    const now = Date.now()
    _micFrameCadenceMs = _lastMicFrameTime ? now - _lastMicFrameTime : null
    _lastMicFrameTime = now   // raw mic delivery — stamped BEFORE the route/idle gate so a paused-but-live mic still reads as live
    setMicInputLevel(pcmInputLevel(e.data))
    sendDeepgramAudioChunk(e.data)
  }
  source.connect(_deepgramWorklet)
  _voiceHealthLabel = deepgramHealthLabel()
  if (_recording) showRecordingHud()

  _lastAudioChunkTime = 0
  _audioHeartbeatInterval = setInterval(() => {
    if (!_recording) return
    const ago = _lastAudioChunkTime ? Date.now() - _lastAudioChunkTime : null
    const ctxState = _deepgramContext?.state
    // The old payload could not tell the two silent-discard states apart, which is
    // why a night was spent guessing between them. `lastChunkMs` is stamped only on a
    // SUCCESSFUL send, so it reads healthy in exactly one of them and dead in the
    // other; the gate terms below say which:
    //   readyEpoch !== speechEpoch  → client gate shut, audio going into the backlog
    //                                 (which prunes at 3s — his words are being erased here)
    //   readyEpoch === speechEpoch but no transcripts → we are sending and the far
    //                                 side is dropping (see the bridge's `recovering` state)
    const backlog = _deepgramAudioBacklog.snapshot(Date.now())
    vlog('audio heartbeat', {
      lastChunkMs: ago,
      wsOpen: _deepgramRelayConnected,
      hasMic: !!_deepgramStream,
      audioCtxState: ctxState,
      speechEpoch: _speechEpoch,
      readyEpoch: _deepgramReadyEpoch,
      gateOpen: _deepgramReadyEpoch === _speechEpoch,
      // Whether he is actually making noise. Without this, a high lastResultMs is
      // ambiguous between "his words are late" and "he stopped talking", and the
      // latency distribution has to be recovered via the `speech started` proxy.
      micAudible: _micAudible,
      pcmPaused: _deepgramPcmPaused,
      upstreamPaused: _dgUpstreamPaused,
      recognizerStatus: currentDeepgramRecognizerStatus(),
      backlogFrames: backlog.frames,
      backlogDropped: backlog.droppedFrames,
      lastResultMs: _lastResultTime ? Date.now() - _lastResultTime : null,
      routed: voiceHasRoute(),
      target: targetLabel(),
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
  _deepgramMicAttempt++
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
function afterSend(submittedTextOverride) {
  const submittedText = submittedTextOverride ?? currentSubmittedVoiceText()
  advanceSpeechEpoch()
  _state = 'edit'
  _left = _interim = _right = ''
  if (_backend === 'whisper-stream') {
    flushWhisperBridge()
    return
  }
  if (_backend === 'deepgram') {
    // No separate finalize here: the bridge's speech_epoch handler now sends Deepgram
    // the Finalize itself, on a socket it keeps open long enough to receive the answer.
    // Sending our own first raced it — the reply could arrive before the epoch bump
    // opened the flush window — and two mechanisms flushing the same utterance is how
    // this bug was built in the first place.
    if (_deepgramWs?.readyState === WebSocket.OPEN) {
      _deepgramPcmPaused = false
      _deepgramReadyEpoch = null
      _deepgramRecognizerStatus = null
      try {
        _deepgramWs.send(JSON.stringify({ type: 'speech_epoch', epoch: _speechEpoch }))
      } catch (err) {
        _deepgramPcmPaused = true
        _deepgramRecoveringEpoch = _speechEpoch
        console.warn('voice: speech epoch control failed', err)
        showDontSpeak('recognizer unavailable; recovering')
      }
    }
    if (normalizeDeepgramText(submittedText)) resetDeepgramTextState({ ignoreUntilUtteranceEnd: true, submittedText })
    else resetDeepgramTextState({ preserveUtteranceGuard: true })
    return
  }
  if (!_recording) return
  if (_isSafari) {
    // Safari: webkitSpeechRecognition is unreliable after stop/start; full reset needed.
    hardResetVoice().then(() => startRecording())
  } else {
    // Chrome recognition instances are epoch-owned. Retire this instance; its
    // onend handler creates a fresh instance whose callbacks capture the new
    // generation before recognition resumes.
    _editStopped = true
    try {
      _recognition?.stop()
    } catch (err) {
      console.warn('voice: epoch recognition retirement failed', err)
    }
  }
}

export function completeMessageSend(submittedText) {
  afterSend(submittedText)
}

// --- Recording ---

// Remote debug logging — sends voice logs to server so agent can read them.
// Whisper backend forwards via _whisperWs (see receive site at line 940).
// Deepgram backend forwards here when the bridge WS is open; the bridge writes
// `[voice] <text>` to ~/.config/tlda/deepgram-sdk-bridge.log so Safari debug is
// observable without Web Inspector / USB pairing.
//
// ⚠️ THIS LOG CANNOT RECORD A DISCONNECT. Read this before trusting it.
//
// These lines ship over the voice WebSocket itself, so any event at or after that
// socket closes is unloggable by construction — including the close. Measured
// 2026-07-25: 0 `bridge WS closed` lines against 129 bridge-side browser disconnects.
// Every [voice] line in that file is survivorship-biased toward a healthy socket, so
// the log is blind at exactly the moment you are trying to debug. A quiet log is not
// a working microphone; it is frequently a dead socket.
//
// Two further traps in the same file: it carries NO timestamps at all (nothing can be
// time-correlated against lag profiles or anything else), and its `browser connected`
// count includes isBridgeUp() health probes, so it is not a client count. The only
// count that means what it says is `connected to Deepgram`.
//
// Fix, when someone has the room for it: route this through src/logger.ts, which POSTs
// to /api/log independently of the voice socket and timestamps every line — that closes
// the blindness and the missing clock together. See docs/voice-path-known-defects.md.
const _voiceLogs = []
function vlog(msg, data) {
  const entry = data ? `${msg} ${JSON.stringify(data)}` : msg
  console.log('voice:', entry)
  _voiceLogs.push(`${new Date().toISOString().slice(11,19)} ${entry}`)
  if (_voiceLogs.length > 50) _voiceLogs.shift()
  // Durable sink. This used to be console + the bridge socket only, which meant the
  // one channel reporting a failure died with the thing that was failing: a discard
  // that happens while the bridge WS is down left no trace anywhere, and the 50-entry
  // ring dies with the tab. log.metric is the ungated sink (log.debug/info are gated
  // at `warn` by default, so they would capture nothing in his session) — batched at
  // 250ms and queue-capped, so it cannot flood the renderer.
  log.metric('voice', msg, data)
  if (_deepgramWs && _deepgramWs.readyState === 1) {
    try { _deepgramWs.send(JSON.stringify({ type: 'log', text: entry })) } catch {}
  }
}

// Rate-limited discard record. The discard points that matter fire per audio frame
// (~50/s) or per interim transcript (~10/s), so an unthrottled line per event would
// be its own incident. First occurrence lands immediately; after that, one line per
// second carrying the suppressed count, so a stuck state reads as a rising count
// rather than disappearing into volume.
const _discardThrottle = new Map()
function vdiscard(key, msg, data) {
  const now = Date.now()
  const prev = _discardThrottle.get(key)
  if (prev && now - prev.at < 1000) { prev.suppressed++; return }
  _discardThrottle.set(key, { at: now, suppressed: 0 })
  const since = prev ? prev.suppressed : 0
  vlog(msg, since ? { ...data, alsoSuppressed: since } : data)
}
// Expose logs for reading via fetch
if (typeof window !== 'undefined') {
  window.__voiceLogs = _voiceLogs
}

// --- Session-independent state probe ---
//
// Every other voice diagnostic dies with the thing it is supposed to report on. The
// audio heartbeat is created by startDeepgramMic and cleared by stopDeepgramMic, and
// its callback opens with `if (!_recording) return`; runVoiceLivenessWatchdog is
// started on record-start and stopped on record-stop. So in the state Skip actually
// describes — "it'll just get locked up not recording, basically", with the HUD still
// showing a target — every one of them is silent, and the gate terms that tell the
// stuck states apart never get sampled.
//
// This interval is owned by the module, not by a recording session: it is never
// cleared, so it keeps sampling across exactly the transitions we cannot currently
// see. It emits only when the state fingerprint CHANGES — so an idle tab writes one
// line and then goes quiet — plus a repeat while voice believes it is recording and
// the pipeline is not delivering, which is the stuck state itself.
let _lastStateFingerprint = null
let _lastStateEmitAt = 0
const VOICE_STATE_SAMPLE_MS = 2000
const VOICE_STATE_STUCK_REPEAT_MS = 15000

function voiceStateSnapshot() {
  return {
    recording: _recording,
    backend: _backend,
    target: targetLabel(),
    routed: voiceHasRoute(),
    speechEpoch: _speechEpoch,
    readyEpoch: _deepgramReadyEpoch,
    gateOpen: _deepgramReadyEpoch === _speechEpoch,
    micAlive: !!_deepgramStream,
    heartbeatAlive: !!_audioHeartbeatInterval,
    relayConnected: _deepgramRelayConnected,
    recognizerStatus: currentDeepgramRecognizerStatus(),
    pcmPaused: _deepgramPcmPaused,
    upstreamPaused: _dgUpstreamPaused,
    guardArmed: _dgIgnoreUntilUtteranceEnd,
    lastResultMs: _lastResultTime ? Date.now() - _lastResultTime : null,
  }
}

// Voice thinks it is on, but something in front of the microphone is not delivering.
// This is the shape of the failure, so it is the one state worth repeating.
function voiceLooksStuck(s) {
  if (!s.recording || s.backend !== 'deepgram') return false
  return !s.gateOpen || !s.micAlive || !s.heartbeatAlive || !s.relayConnected
}

if (typeof window !== 'undefined') {
  setInterval(() => {
    const snapshot = voiceStateSnapshot()
    // Volatile fields are excluded from the fingerprint so ordinary progress does not
    // read as a state change; they still ride along on every line we do emit.
    const { lastResultMs, ...stable } = snapshot
    const fingerprint = JSON.stringify(stable)
    const now = Date.now()
    const changed = fingerprint !== _lastStateFingerprint
    const stuckRepeat = voiceLooksStuck(snapshot) && now - _lastStateEmitAt >= VOICE_STATE_STUCK_REPEAT_MS
    if (!changed && !stuckRepeat) return
    _lastStateFingerprint = fingerprint
    _lastStateEmitAt = now
    vlog(changed ? 'voice state changed' : 'voice state STUCK', snapshot)
  }, VOICE_STATE_SAMPLE_MS)
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
  advanceSpeechEpoch()
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
    connectDeepgramBridge(_deepgramRelayGeneration)
    startDeepgramMic()
    // Ensure Deepgram session is started (may have been stopped by hardResetVoice)
    if (_deepgramWs && _deepgramRelayConnected) {
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
  if (!_recording) {
    if (_backend === 'deepgram') disconnectDeepgramBridge()
    return
  }
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
    disconnectDeepgramBridge()
  }

  // Notify accumulator that recording stopped (caller can reset cursor anchor etc.)
  if (_accumulator?.onStop) _accumulator.onStop()

  showHud('off', '#9370db')
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
  advanceSpeechEpoch()
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
    vlog('hardReset/dg: keeping mic warm', { wsOpen: _deepgramRelayConnected, hasMic: !!_deepgramStream })
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

  if (_activeTargetHandle?.submitCurrent) {
    if (!_activeTargetHandle.submitCurrent()) return
  } else if (_activeTargetHandle?.sendVoice) {
    _activeTargetHandle.sendVoice(targets, text)
    afterSend(text)
    _filling = true
    ta.value = ''
    ta.style.height = 'auto'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    _filling = false
  } else {
    return
  }

  const who = targetLabel()
  showHud(`sent → ${who}`, '#7ab8a0')
  fadeHud(2500)
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
  let prefMeter = getPref('voice-hud-meter')

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
      const res = await fetch('/api/voice/deepgram-sdk/start', { method: 'POST' })
      setDirectBridgeUrl((await res.json())?.directUrl)
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
    if (nextPrefBackend !== prefBackend) {
      prefBackend = nextPrefBackend
      setBackend(nextPrefBackend)
    }
    const nextPrefMeter = getPref('voice-hud-meter')
    if (nextPrefMeter !== prefMeter) {
      prefMeter = nextPrefMeter
      paintMicLevel()
    }
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
        if (!_deepgramRelayConnected) {
          vlog('visibilitychange: bridge disconnected — reconnecting')
          connectDeepgramBridge(_deepgramRelayGeneration)
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
  if (!_recording && !_callState) showHud('off', '#9370db')
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
export function getSpeechEpoch() { return _speechEpoch }
export function getBackend() { return _backend }
export function isWhisperAvailable() { return _whisperAvailable }
export async function setBackend(be) {
  if (be === 'whisper') be = 'whisper-stream' // prefs dropdown uses the short name
  if (be === 'deepgram' || be === 'deepgram-sdk') be = 'deepgram'
  // Explicit "off": no backend enabled. Stop any recording and go silent.
  if (be === '' || be === 'none') {
    if (_recording) stopRecording()
    else if (_backend === 'deepgram') disconnectDeepgramBridge()
    _backend = 'none'
    showHud('off', '#9370db')
    return
  }
  if (be !== 'chrome' && be !== 'whisper-stream' && be !== 'deepgram') return
  if (be === _backend) return
  if (be === 'chrome' && !SpeechRecognition) return
  // Lazy-start the target backend on demand. init only starts the backend it
  // commits to; a live switch or late-loaded saved pref must start its selected
  // backend here instead of silently no-oping on a stale availability flag.
  if (be === 'deepgram') {
    try {
      const res = await fetch('/api/voice/deepgram-sdk/start', { method: 'POST' })
      setDirectBridgeUrl((await res.json())?.directUrl)
    } catch (err) {
      // Not swallowed: failing here means we did not learn which machine to send
      // his audio to, and the connect below will use the same-origin proxy. That
      // is a route change worth being able to see in a log.
      console.warn('voice: deepgram lazy-start request failed', err)
    }
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
  else if (_backend === 'deepgram') disconnectDeepgramBridge()
  _backend = be
  if (wasRecording) startRecording()
  showHud(`voice: ${be === 'deepgram' ? 'deepgram-sdk' : be}`, '#9370db')
  fadeHud(2000)
}
/** @param {string | null | undefined} submittedText */
export function resetTranscript(submittedText = undefined) {
  _state = 'edit'
  advanceSpeechEpoch()
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
