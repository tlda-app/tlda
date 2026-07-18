#!/usr/bin/env node
// deepgram-sdk-bridge.mjs — SDK-backed sibling of deepgram-bridge.mjs.
// Browser connects to ws://localhost:8180, sends raw PCM audio, receives the
// same transcript/status JSON contract as the raw WebSocket bridge.
//
// Usage:
//   node bin/deepgram-sdk-bridge.mjs [--port 8180] [--key DEEPGRAM_API_KEY]

import { DeepgramClient } from '@deepgram/sdk'
import { acceptsSpeechEpoch, createEpochTransition, enqueueEpochPcm, readyEpochTransition } from './deepgram-epoch-state.mjs'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer as createHttpsServer } from 'https'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadConfig } from '../shared/config.mjs'

const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 8180

function resolveApiKey() {
  if (process.argv.includes('--key')) {
    return process.argv[process.argv.indexOf('--key') + 1]
  }
  if (process.env.DEEPGRAM_API_KEY) {
    return process.env.DEEPGRAM_API_KEY
  }
  try {
    const config = loadConfig()
    if (config.deepgramApiKey) return config.deepgramApiKey
  } catch {}
  return null
}

const API_KEY = resolveApiKey()
if (!API_KEY) {
  console.error('[deepgram-sdk-bridge] No API key found. Set DEEPGRAM_API_KEY, use --key, or add deepgramApiKey to ~/.config/tlda/config.json')
  process.exit(1)
}

// CLI flag → config key → default. Used for the idle-cutoff tunable so Skip can
// feel-test without a rebuild (config) and tests can pin short values (flags).
function resolveIntOpt(flag, configKey, def) {
  if (process.argv.includes(flag)) {
    const v = parseInt(process.argv[process.argv.indexOf(flag) + 1], 10)
    if (Number.isFinite(v)) return v
  }
  try {
    const config = loadConfig()
    if (config[configKey] != null && Number.isFinite(Number(config[configKey]))) return Number(config[configKey])
  } catch { /* config is an optional tuning surface — fall through to the default */ }
  return def
}

// Idle cutoff: close the upstream session after this many ms with no Deepgram
// speech activity (its own VAD), so a warm/silent session is never kept alive
// (and never billed). 30s is long enough not to interrupt a thinking pause
// (connection stays warm → instant, no clipped words) but closes an abandoned
// session. After a cutoff the bridge waits — it reconnects only when the audio
// it receives actually contains sound (see RESUME_RMS_THRESHOLD).
const IDLE_CUTOFF_MS = resolveIntOpt('--idle-ms', 'idleCutoffMs', 30000)
// Resume gate: after an idle cutoff, reconnect upstream only when an incoming PCM
// frame's RMS energy exceeds this — i.e. the user is actually speaking, not a
// silent-but-live mic. Energy magnitude (not a timestamp) is the discriminator;
// a quiet mic's noise floor sits below this, real speech well above. Device-ish,
// so it's tunable; the default is conservative. Linear16 RMS is 0..32767.
const RESUME_RMS_THRESHOLD = resolveIntOpt('--resume-rms', 'resumeRmsThreshold', 250)
// Pre-roll kept while idle so the first words after a pause aren't clipped through
// the reconnect: when speech resumes we flush this buffer ahead of the live audio.
const PREROLL_MS = resolveIntOpt('--preroll-ms', 'prerollMs', 300)
const PREROLL_MAX_BYTES = Math.round(16000 * 2 * (PREROLL_MS / 1000)) // 16kHz · 2 bytes/sample

// RMS of a linear16 (Int16 LE) PCM buffer. Pure → unit-tested.
function rmsOfPcm(buf) {
  const n = Math.floor(buf.length / 2)
  if (n === 0) return 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2)
    sumSq += s * s
  }
  return Math.sqrt(sumSq / n)
}

console.log(`[deepgram-sdk-bridge] idle cutoff ${IDLE_CUTOFF_MS}ms; resume RMS ${RESUME_RMS_THRESHOLD}; preroll ${PREROLL_MS}ms; redials only on real audio / explicit start`)

const KEYWORDS = [
  'Bregman', 'estimand', 'estimands', 'Riesz', 'RKHS', 'Hilbert',
  'Sobolev', 'Matérn', 'semiparametric', 'minimax', 'nuisance',
  'Donoho', 'Hirshberg', 'Wager', 'AMLE',
  'theta', 'phi', 'gamma', 'psi', 'tau', 'eta', 'chi', 'xi', 'zeta',
  'mu', 'nu', 'rho', 'sigma', 'lambda', 'epsilon', 'delta', 'alpha', 'beta',
  'lemma', 'seminorm', 'asymptotic', 'doubly robust', 'cross-fitting',
  'kernel balancing', 'synthetic control', 'kernel ridge',
]

// Tunable Deepgram recognition params. Defaults are docs-backed; any of them can
// be overridden at RUNTIME with no rebuild (Skip 6/19: "tweakable parameters to
// just play with so we don't have to rebuild all the time") by adding a
// `voiceParams` object to ~/.config/tlda/config.json. listenOptions() re-reads the
// config on every Deepgram connect, so editing the file and starting a fresh voice
// session (toggle voice off→on, or reconnect) applies the change.
//
// To widen the recognition window so Deepgram stops cutting off / revising the
// tail of an utterance ("it keeps eating parts of my text… make our window
// bigger"), raise endpointing and utterance_end_ms, e.g.:
//   "voiceParams": { "endpointing": 500, "utterance_end_ms": 1500 }
const DEFAULT_LISTEN_OPTIONS = {
  model: 'nova-3',
  language: 'en',
  smart_format: true,
  punctuate: true,
  interim_results: true,
  endpointing: 300,
  utterance_end_ms: 1000,
  vad_events: true,
  encoding: 'linear16',
  sample_rate: 16000,
  channels: 1,
}

function loadVoiceParamOverrides() {
  try {
    const config = loadConfig()
    if (config.voiceParams && typeof config.voiceParams === 'object') return config.voiceParams
  } catch {
    // Config is an OPTIONAL tuning surface — if it's missing/unreadable, voice
    // must still work on the docs-backed defaults. No overrides, no failure.
  }
  return {}
}

function listenOptions(clientOverrides = {}) {
  // Precedence: docs-backed defaults < config.json voiceParams < per-connection
  // client params (Skip's Preferences, sent in the `start` message).
  const overrides = { ...loadVoiceParamOverrides(), ...clientOverrides }
  const recognition = { ...DEFAULT_LISTEN_OPTIONS, ...overrides }
  if (Object.keys(overrides).length) {
    console.log('[deepgram-sdk-bridge] voiceParams overrides applied:', JSON.stringify(overrides))
  }
  console.log('[deepgram-sdk-bridge] effective listen options:', JSON.stringify(recognition))
  return {
    ...recognition,
    queryParams: { keyterm: KEYWORDS },
    Authorization: `Token ${API_KEY}`,
    reconnectAttempts: 30,
    connectionTimeoutInSeconds: 10,
  }
}

const tlsDir = join(homedir(), '.config/tlda')
const tlsCert = join(tlsDir, 'localhost+2.pem')
const tlsKey  = join(tlsDir, 'localhost+2-key.pem')
const useTls = existsSync(tlsCert) && existsSync(tlsKey)

let wss
if (useTls) {
  const httpsServer = createHttpsServer({
    cert: readFileSync(tlsCert),
    key: readFileSync(tlsKey),
  })
  wss = new WebSocketServer({ server: httpsServer })
  httpsServer.listen(PORT)
  console.log(`[deepgram-sdk-bridge] WebSocket server on wss://localhost:${PORT}`)
} else {
  wss = new WebSocketServer({ port: PORT })
  console.log(`[deepgram-sdk-bridge] WebSocket server on ws://localhost:${PORT}`)
}
console.log(`[deepgram-sdk-bridge] Using ${KEYWORDS.length} keyterm boosts`)

function sendToBrowser(ws, msg) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg)
  if (ws.readyState === WebSocket.OPEN) ws.send(str)
}

wss.on('connection', (browserWs) => {
  console.log(`[deepgram-sdk-bridge] browser connected (${wss.clients.size} total)`)

  const client = new DeepgramClient({ apiKey: API_KEY })
  let dg = null
  let connecting = null
  let keepAliveInterval = null
  let manuallyClosed = false
  let idleTimer = null
  let lastSpeechAt = 0
  let idleClosed = false        // upstream closed by the idle cutoff — wait for `start`
  let reconnectFailures = 0     // consecutive failed/dropped connects (drives backoff)
  let lastConnectAt = 0         // timestamp of the last upstream connect attempt (throttle)
  let preroll = []              // recent PCM frames buffered while idle (anti-clip on resume)
  let prerollBytes = 0
  // Per-connection tunables — default to the bridge config, overridden by the
  // values the client sends in its `start` message (Skip's Preferences).
  let idleMs = IDLE_CUTOFF_MS
  let resumeRms = RESUME_RMS_THRESHOLD
  let prerollMaxBytes = PREROLL_MAX_BYTES
  let clientVoiceParams = {}    // per-connection Deepgram recognition overrides (endpointing, utterance_end_ms)
  let activeEpoch = null
  let epochTransition = null
  let connectionAttemptId = 0

  function closeConnection(connection, context) {
    try {
      connection.close()
    } catch (err) {
      console.warn(`[deepgram-sdk-bridge] ${context} close failed:`, err.message)
    }
  }

  function epochQueueMaxBytes() {
    return 16000 * 2 * Number(listenOptions(clientVoiceParams).connectionTimeoutInSeconds || 10)
  }

  function emitEpochLoss(transition, reason, rejectedBytes = 0) {
    if (!transition || transition.lossEmitted) return
    transition.lossEmitted = true
    sendToBrowser(browserWs, {
      type: 'epoch_loss', epoch: transition.epoch, queuedBytes: transition.pcmBytes,
      rejectedBytes, reason,
    })
  }

  function retireEpoch(reason) {
    if (epochTransition?.pcmBytes > 0) emitEpochLoss(epochTransition, reason)
    epochTransition = null
    clearInterval(keepAliveInterval)
    keepAliveInterval = null
    clearInterval(idleTimer)
    idleTimer = null
    const old = dg
    connectionAttemptId++
    dg = null
    connecting = null
    if (old) {
      try {
        sendDeepgramJson(old, { type: 'CloseStream' })
      } catch (err) {
        console.warn('[deepgram-sdk-bridge] retire CloseStream failed:', err.message)
      }
      closeConnection(old, 'retired epoch')
    }
  }

  function revokeConnectionAttempt(context) {
    connectionAttemptId++
    connecting = null
    clearInterval(keepAliveInterval)
    keepAliveInterval = null
    clearInterval(idleTimer)
    idleTimer = null
    const revoked = dg
    dg = null
    if (revoked) closeConnection(revoked, context)
  }

  function applyClientParams(msg) {
    if (Number.isFinite(msg?.idleMs) && msg.idleMs > 0) idleMs = msg.idleMs
    if (Number.isFinite(msg?.resumeRms) && msg.resumeRms >= 0) resumeRms = msg.resumeRms
    if (Number.isFinite(msg?.prerollMs) && msg.prerollMs >= 0) prerollMaxBytes = Math.round(16000 * 2 * (msg.prerollMs / 1000))
    if (Number.isFinite(msg?.endpointing) && msg.endpointing >= 0) clientVoiceParams.endpointing = msg.endpointing
    if (Number.isFinite(msg?.utterance_end_ms) && msg.utterance_end_ms >= 0) clientVoiceParams.utterance_end_ms = msg.utterance_end_ms
  }

  function pushPreroll(buf) {
    preroll.push(buf)
    prerollBytes += buf.length
    while (prerollBytes > prerollMaxBytes && preroll.length > 1) {
      prerollBytes -= preroll.shift().length
    }
  }

  function isDeepgramOpen(connection = dg) {
    return connection?.socket?.readyState === WebSocket.OPEN
  }

  function sendDeepgramJson(connection, msg) {
    if (!isDeepgramOpen(connection)) return false
    connection.socket.send(JSON.stringify(msg))
    return true
  }

  function sendDeepgramAudio(connection, data) {
    if (!isDeepgramOpen(connection)) return false
    connection.socket.send(data)
    return true
  }

  function attachDeepgramConnection(connection, epoch, attemptId) {
    dg = connection

    connection.on('open', () => {
      if (connection !== dg || epoch !== activeEpoch || attemptId !== connectionAttemptId) {
        closeConnection(connection, 'stale open')
        return
      }
      console.log('[deepgram-sdk-bridge] connected to Deepgram')
      reconnectFailures = 0
      lastSpeechAt = Date.now()
      const readyResult = readyEpochTransition(epochTransition, epoch, attemptId, frame => sendDeepgramAudio(connection, frame))
      if (readyResult !== 'stale') {
        const transition = epochTransition
        if (readyResult === 'failed') {
          emitEpochLoss(transition, 'queue-drain-failed')
          transition.state = 'recovering'
          sendToBrowser(browserWs, { type: 'epoch_error', epoch, reason: 'queue-drain-failed' })
          return
        }
        sendToBrowser(browserWs, { type: 'epoch_ready', epoch })
      }
      sendToBrowser(browserWs, { type: 'status', status: 'connected', implementation: 'sdk', epoch })
      keepAliveInterval = setInterval(() => {
        try { sendDeepgramJson(dg, { type: 'KeepAlive' }) } catch {}
      }, 3000)
      // Idle cutoff: if Deepgram's own VAD reports no speech for IDLE_CUTOFF_MS,
      // close the upstream session so silence is never billed. The client resumes
      // (sends `start`) when it hears speech again.
      clearInterval(idleTimer)
      idleTimer = setInterval(() => {
        if (!isDeepgramOpen()) return
        if (Date.now() - lastSpeechAt > idleMs) idleCutoff()
      }, 1000)
    })

    connection.on('message', (msg) => {
      if (connection !== dg || epoch !== activeEpoch || attemptId !== connectionAttemptId) return
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0]
        if (!alt || !alt.transcript) return
        const text = alt.transcript.trim()
        if (!text) return

        lastSpeechAt = Date.now() // speech activity → keep the upstream session alive
        console.log(`[deepgram-sdk-bridge] transcript: is_final=${msg.is_final} speech_final=${msg.speech_final} from_finalize=${msg.from_finalize} "${text.slice(0, 60)}"`)
        sendToBrowser(browserWs, {
          type: 'transcript',
          text,
          is_final: msg.is_final || false,
          speech_final: msg.speech_final || false,
          from_finalize: msg.from_finalize || false,
          timestamp: Date.now(),
          epoch,
        })
        return
      }

      if (msg.type === 'SpeechStarted') {
        lastSpeechAt = Date.now()
        console.log('[deepgram-sdk-bridge] speech started')
        sendToBrowser(browserWs, { type: 'speech_started', timestamp: Date.now(), epoch })
        return
      }

      if (msg.type === 'UtteranceEnd') {
        sendToBrowser(browserWs, { type: 'utterance_end', timestamp: Date.now(), epoch })
        return
      }

      if (msg.type === 'Metadata') {
        sendToBrowser(browserWs, { type: 'metadata', request_id: msg.request_id, timestamp: Date.now() })
      }
    })

    connection.on('close', (event) => {
      if (connection !== dg || epoch !== activeEpoch || attemptId !== connectionAttemptId) return
      clearInterval(keepAliveInterval)
      keepAliveInterval = null
      clearInterval(idleTimer)
      idleTimer = null
      if (dg === connection) dg = null
      connecting = null
      if (manuallyClosed || idleClosed) return
      // Unexpected drop — INCLUDING Deepgram's own no-audio/timeout close. Do NOT
      // self-redial: that instant auto-reconnect (no "should I be connected?"
      // check) was the 555K-reconnect storm. We only reconnect when the client
      // sends real audio or an explicit `start`, and connectDeepgram() throttles
      // with backoff. Just count the failure so the throttle widens.
      reconnectFailures++
      if (reconnectFailures <= 2 || reconnectFailures % 10 === 0) {
        console.log(`[deepgram-sdk-bridge] upstream closed (code ${event?.code ?? '?'}); not redialing — waits for audio/start (drop #${reconnectFailures})`)
      }
    })

    connection.on('error', (err) => {
      if (connection !== dg || epoch !== activeEpoch || attemptId !== connectionAttemptId) return
      console.error('[deepgram-sdk-bridge] Deepgram error:', err.message)
      sendToBrowser(browserWs, { type: 'status', status: 'error', error: err.message, implementation: 'sdk', epoch, attemptId })
    })
  }

  async function connectDeepgram(epoch = activeEpoch) {
    if (dg || connecting) return connecting
    const attemptId = ++connectionAttemptId
    // STORM GUARD — reconnects only happen here (driven by real audio or an
    // explicit `start`), never on a self-scheduled timer. After a failure/drop we
    // back off exponentially, so a session Deepgram keeps closing (its no-audio
    // timeout, a 402, etc.) can't loop — that loop was the 555K-reconnect storm.
    // An explicit `start` resets reconnectFailures, so user intent connects now.
    const backoff = reconnectFailures > 0 ? Math.min(30000, 1000 * 2 ** (reconnectFailures - 1)) : 0
    if (backoff && Date.now() - lastConnectAt < backoff) return null
    lastConnectAt = Date.now()
    // A fresh connect (incl. voice OFF→ON after a stop-triggered disconnect)
    // re-arms auto-reconnect: clear the manual-close flag set by disconnectDeepgram().
    manuallyClosed = false
    connecting = (async () => {
      const connection = await client.listen.v1.connect(listenOptions(clientVoiceParams))
      if (epoch !== activeEpoch || attemptId !== connectionAttemptId) {
        closeConnection(connection, 'stale connect')
        return null
      }
      attachDeepgramConnection(connection, epoch, attemptId)
      connection.connect()
      await connection.waitForOpen()
      return connection
    })().catch(err => {
      if (attemptId === connectionAttemptId) connecting = null
      reconnectFailures++
      console.error('[deepgram-sdk-bridge] connect failed:', err.message)
      if (epoch === activeEpoch && attemptId === connectionAttemptId) {
        if (epochTransition) emitEpochLoss(epochTransition, 'connect-failed')
        sendToBrowser(browserWs, { type: 'epoch_error', epoch, reason: 'connect-failed' })
      }
      if (epoch === activeEpoch && attemptId === connectionAttemptId) {
        sendToBrowser(browserWs, { type: 'status', status: 'error', error: err.message, implementation: 'sdk', epoch, attemptId })
      }
      return null
    })
    return connecting
  }

  // Close the upstream session because Deepgram saw no speech for IDLE_CUTOFF_MS.
  // Marks idleClosed so we won't auto-reconnect and so incoming audio is dropped
  // until the client explicitly sends `start` again (no flap on a quiet mic).
  function idleCutoff() {
    console.log(`[deepgram-sdk-bridge] idle cutoff — no speech for ${IDLE_CUTOFF_MS}ms, closing upstream`)
    idleClosed = true
    disconnectDeepgram()
    sendToBrowser(browserWs, { type: 'status', status: 'idle', implementation: 'sdk', epoch: activeEpoch, attemptId: connectionAttemptId })
  }

  function disconnectDeepgram() {
    manuallyClosed = true
    clearInterval(keepAliveInterval)
    keepAliveInterval = null
    clearInterval(idleTimer)
    idleTimer = null
    if (dg) {
      try { sendDeepgramJson(dg, { type: 'CloseStream' }) } catch {}
      try { dg.close() } catch {}
      dg = null
    }
  }

  browserWs.on('message', (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.from(data)
      if (epochTransition?.state === 'connecting') {
        const maxBytes = epochQueueMaxBytes()
        if (!enqueueEpochPcm(epochTransition, frame, maxBytes)) {
          revokeConnectionAttempt('overflowed epoch')
          emitEpochLoss(epochTransition, 'queue-overflow', frame.length)
          epochTransition.state = 'recovering'
          sendToBrowser(browserWs, { type: 'epoch_error', epoch: epochTransition.epoch, reason: 'queue-overflow' })
          return
        }
        return
      }
      if (epochTransition?.state === 'recovering') return
      // After an idle cutoff the upstream is closed. A continuously-streaming
      // client must NOT instantly reconnect (that defeats the cutoff and was the
      // storm). Resume ONLY when the audio actually contains sound (RMS), not on a
      // silent-but-live mic. Buffer silence as pre-roll so the first words after
      // the pause aren't clipped through the reconnect.
      if (idleClosed) {
        if (rmsOfPcm(frame) < resumeRms) { pushPreroll(frame); return }
        // Real speech → resume. Treat like user intent: clear the gate + backoff.
        console.log('[deepgram-sdk-bridge] resume — speech after idle, reconnecting upstream')
        idleClosed = false
        reconnectFailures = 0
        const frames = [...preroll, frame]
        preroll = []; prerollBytes = 0
        connectDeepgram().then(connection => {
          if (!connection || browserWs.readyState !== WebSocket.OPEN) return
          for (const f of frames) { try { sendDeepgramAudio(connection, f) } catch {} }
        })
        return
      }
      if (isDeepgramOpen()) {
        try { sendDeepgramAudio(dg, data) } catch (err) { console.warn('[deepgram-sdk-bridge] audio send failed:', err.message) }
        return
      }
      const pending = Buffer.from(data)
      connectDeepgram().then(connection => {
        if (!connection || browserWs.readyState !== WebSocket.OPEN) return
        try {
          if (!sendDeepgramAudio(connection, pending)) {
            console.warn('[deepgram-sdk-bridge] pending audio dropped: socket not open')
          }
        } catch (err) {
          console.warn('[deepgram-sdk-bridge] pending audio send failed:', err.message)
        }
      })
      return
    }

    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'speech_epoch') {
        if (!acceptsSpeechEpoch(activeEpoch, msg.epoch)) {
          sendToBrowser(browserWs, { type: 'epoch_error', epoch: msg.epoch, reason: 'non-monotone-epoch' })
          return
        }
        retireEpoch('superseded')
        activeEpoch = msg.epoch
        preroll = []; prerollBytes = 0
        epochTransition = createEpochTransition(activeEpoch, connectionAttemptId + 1)
        manuallyClosed = false
        reconnectFailures = 0
        connectDeepgram(activeEpoch)
      } else if (msg.type === 'start') {
        // Explicit user intent (voice ON / resume after idle): clear the idle
        // gate and reset the backoff so we connect immediately. Pick up any
        // client-tuned conservation params (Skip's Preferences).
        applyClientParams(msg)
        idleClosed = false
        reconnectFailures = 0
        if (Number.isSafeInteger(msg.epoch) && msg.epoch === activeEpoch) {
          retireEpoch('recovery')
          epochTransition = createEpochTransition(activeEpoch, connectionAttemptId + 1)
        }
        connectDeepgram(activeEpoch)
      } else if (msg.type === 'finalize' || msg.type === 'flush') {
        try { sendDeepgramJson(dg, { type: 'Finalize' }) } catch {}
      } else if (msg.type === 'stop') {
        // Voice OFF must end the upstream Deepgram session, or it stays open
        // (held by the 3 s KeepAlive) and keeps billing. The client tears down
        // the mic on stop but leaves this WS open for a later 'start', so tab
        // close is NOT a reliable end-of-session — disconnect upstream here.
        disconnectDeepgram()
      } else if (msg.type === 'log') {
        console.log(`[voice] ${msg.text}`)
      }
    } catch {}
  })

  browserWs.on('close', () => {
    console.log(`[deepgram-sdk-bridge] browser disconnected (${wss.clients.size} total)`)
    disconnectDeepgram()
  })
})

process.on('SIGINT', () => process.exit())
process.on('SIGTERM', () => process.exit())
