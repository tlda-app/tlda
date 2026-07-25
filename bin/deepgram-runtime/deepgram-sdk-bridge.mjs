#!/usr/bin/env node
// deepgram-sdk-bridge.mjs — SDK-backed sibling of deepgram-bridge.mjs.
// Browser connects to ws://localhost:8180, sends raw PCM audio, receives the
// same transcript/status JSON contract as the raw WebSocket bridge.
//
// Usage:
//   node bin/deepgram-runtime/deepgram-sdk-bridge.mjs [--port 8180] [--key DEEPGRAM_API_KEY]

import { DeepgramClient } from '@deepgram/sdk'
import { acceptsSpeechEpoch, createEpochTransition, enqueueEpochPcm, readyEpochTransition } from './deepgram-epoch-state.mjs'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer as createHttpsServer } from 'https'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

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
  return null
}

const API_KEY = resolveApiKey()
if (!API_KEY) {
  console.error('[deepgram-sdk-bridge] No API key found. Set DEEPGRAM_API_KEY or use --key.')
  process.exit(1)
}

// CLI flag → config key → default. Used for the idle-cutoff tunable so Skip can
// feel-test without a rebuild (config) and tests can pin short values (flags).
function resolveIntOpt(flag, _configKey, def) {
  if (process.argv.includes(flag)) {
    const v = parseInt(process.argv[process.argv.indexOf(flag) + 1], 10)
    if (Number.isFinite(v)) return v
  }
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
// Backstop for the epoch carry. It releases FORWARD, so its failure mode is a few
// duplicated words rather than swallowed ones.
//
// It was 4000ms, sized on my belief that it "should effectively never fire" because the
// explicit Finalize would reliably produce a prompt is_final. IT FIRED ON THE FIRST REAL
// TRIGGER. While it is carrying, results are stamped with the dead epoch and the client
// drops them — so an oversized backstop is a word-loss window, not a safety net. 800ms is
// generous against a typical finalize latency of a few hundred ms and bounds the damage.
//
// THE PATTERN, because this is the third time in this file: I had already measured
// from_finalize at 22 occurrences in an entire log — direct evidence that the flush
// usually produces nothing — and then designed around the flush reliably answering. Same
// shape as declaring the tail-loss diagnosis falsified and leaving the code that rested on
// it, and as leaving a comment describing a flush window I had deleted. **When a
// measurement invalidates a claim, re-examine everything you justified with that claim,
// not just the claim.** The number was in hand every time; carrying it through was the
// step that got skipped.
//
// If this is still firing on ordinary sends, the mechanism is wrong in a way we have not
// understood — do not tune this constant a second time.
const CARRY_BACKSTOP_MS = 800

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

// Deepgram recognition defaults. Per-connection options can override them;
// secrets and runtime settings are never read from YAML or a generic config.
//
// To widen the recognition window so Deepgram stops cutting off / revising the
// tail of an utterance ("it keeps eating parts of my text… make our window
// bigger"), raise endpointing and utterance_end_ms on the connection.
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
  return {}
}

function listenOptions(clientOverrides = {}) {
  // Precedence: docs-backed defaults < per-connection client params.
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

// Rate-limited discard record. Several of these fire per audio frame (~50/s), so an
// unthrottled line each would be its own incident. First occurrence lands immediately;
// after that one line per second carrying the count it stands for, so a stuck state
// reads as a rising number instead of vanishing into volume.
const _discardThrottle = new Map()
function logDiscard(key, msg, data) {
  const now = Date.now()
  const prev = _discardThrottle.get(key)
  if (prev && now - prev.at < 1000) { prev.suppressed++; return }
  _discardThrottle.set(key, { at: now, suppressed: 0 })
  const payload = prev && prev.suppressed ? { ...data, alsoSuppressed: prev.suppressed } : data
  console.warn(`[deepgram-sdk-bridge] ${msg} ${JSON.stringify(payload)}`)
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
  // Epoch belongs to the SESSION, not the socket. It used to be a closure parameter on
  // the Deepgram connection, which meant the only way to advance it was to redial —
  // that redial fired after every message Skip sent (~68 in 46 min, none caused by any
  // failure) and each one closed an audio gate in front of his microphone.
  //
  // The obvious worry is the previous message's tail leaking into the next box, and the
  // obvious fix is to keep stamping the old epoch until Deepgram answers our Finalize.
  // DON'T. That was tried here and it is wrong: Deepgram has never once answered a
  // Finalize in production (0 of 5038 results came back from_finalize=true), so the
  // boundary would fall to a timeout, and every millisecond of that timeout discards
  // FRESH speech — his first words after a send, which is exactly what he is
  // complaining about.
  //
  // The tail is already handled, content-first, on the client: after a send it holds
  // _dgIgnoredSubmittedText and drops any result matching the text it just sent,
  // releasing on the first result that doesn't match (voice.mjs:2276). That is a
  // content boundary, not a clock, so it cannot eat fresh words. The epoch does not
  // need to re-solve it, and a second mechanism for one job is how this bug was built.
  let connectionAttemptId = 0
  let lastBrowserAudioAt = 0
  let lastUpstreamAudioAt = 0
  let lastTranscriptAt = 0
  let pendingFinalSince = 0
  // While non-null, results are stamped with this epoch instead of activeEpoch: the
  // previous utterance is still being finished by Deepgram after an epoch advance.
  // Cleared by the utterance's own is_final (the real boundary), or by the backstop.
  let carriedEpoch = null
  let carryTimer = null
  // True while a non-final transcript is genuinely outstanding. Deliberately NOT
  // pendingFinalSince, which SpeechStarted also sets (3942 times in one log) on bare VAD
  // with no transcript behind it. Arming on that would carry when there is nothing to
  // carry, and the next is_final — belonging to FRESH speech — would be stamped with the
  // dead epoch and dropped. That loses his words, which is the one outcome worse than
  // the duplication this fixes.
  let interimOutstanding = false
  let droppedChunks = 0
  let flushedChunks = 0

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
    releaseCarriedEpoch(`retired: ${reason}`)
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

  // Stop carrying the previous utterance's epoch: subsequent results belong to the new
  // one. Releasing always moves FORWARD to activeEpoch — never back — because the two
  // failure directions are not symmetric. Releasing early duplicates a few words;
  // holding too long stamps fresh speech with a dead epoch and the client discards it.
  // Skip has told us which of those hurts: "it keeps eating parts of my text." So every
  // uncertain path here errs toward duplication.
  function releaseCarriedEpoch(reason) {
    if (carriedEpoch === null) return
    clearTimeout(carryTimer)
    carryTimer = null
    // Log EVERY release, including the ordinary `final` one. Silencing the common path
    // left no denominator: the log showed backstop firings with nothing to compare them
    // against, so "is the backstop still the common path?" — the actual ship bar — was
    // unanswerable from the data. A check you cannot evaluate is not a check.
    console.log(`[deepgram-sdk-bridge] carry released by ${reason} (epoch ${carriedEpoch} → ${activeEpoch})`)
    carriedEpoch = null
  }

  // Advance the epoch on the LIVE socket. This is the path that used to be a full
  // teardown and redial of Deepgram after every message Skip sent.
  function advanceEpochOnLiveSocket(nextEpoch) {
    // A result describing audio he spoke BEFORE the send must not be stamped with the
    // epoch AFTER it — that is how the tail of one message reappeared as the head of the
    // next. Deepgram finishes the in-flight utterance a moment after the bump, both as
    // the `Finalize` reply and as an ordinary is_final, so the boundary is real and has
    // to be carried across.
    //
    // The boundary is CONTENT — the utterance's own is_final — not a clock. An earlier
    // version of this used a fixed 1200ms window, which is worse than the bug: any
    // window that outlasts the boundary stamps fresh speech with the old epoch and loses
    // his words. And it is not keyed on from_finalize either: only 22 of those exist in
    // the whole log, while ordinary is_final crossings are the common case.
    //
    // Only arm when an utterance is genuinely mid-flight. If nothing is pending there is
    // nothing to carry, and the common case costs nothing.
    if (interimOutstanding && activeEpoch !== null) {
      carriedEpoch = activeEpoch
      clearTimeout(carryTimer)
      // Backstop only. If Deepgram never finalizes, release forward rather than keep
      // holding — and log it, so a recognizer that stops finalizing shows up as data
      // instead of as him noticing words go missing.
      carryTimer = setTimeout(() => releaseCarriedEpoch('backstop timeout'), CARRY_BACKSTOP_MS)
    }
    activeEpoch = nextEpoch
    epochTransition = null
    preroll = []; prerollBytes = 0
    // Ask Deepgram to close out the utterance he just sent. Unlike before, the socket
    // survives long enough to actually receive the answer — so the tail he spoke before
    // hitting send finally comes back instead of dying with the connection.
    sendDeepgramJson(dg, { type: 'Finalize' })
    // Open his audio gate immediately. The client refuses to send audio until it sees
    // epoch_ready (voice.mjs:871), so this line decides whether he is talking into a
    // recognizer or into a backlog buffer. Nothing needs to be waited for: Deepgram
    // takes a continuous stream and attributes post-Finalize audio to the next
    // utterance. The carry above changes only how results are LABELLED, never when his
    // microphone reopens.
    sendToBrowser(browserWs, { type: 'epoch_ready', epoch: activeEpoch })
    emitBridgeTelemetry()
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

  function bridgeSnapshot() {
    const now = Date.now()
    return {
      upstreamConnected: isDeepgramOpen(),
      lastBrowserAudioAgoMs: lastBrowserAudioAt ? now - lastBrowserAudioAt : null,
      lastUpstreamAudioAgoMs: lastUpstreamAudioAt ? now - lastUpstreamAudioAt : null,
      transcriptLatencyMs: lastTranscriptAt && lastUpstreamAudioAt ? Math.max(0, lastTranscriptAt - lastUpstreamAudioAt) : null,
      pendingFinalAgeMs: pendingFinalSince ? now - pendingFinalSince : null,
      reconnectCount: reconnectFailures,
      droppedChunks,
      flushedChunks,
      epoch: activeEpoch,
      attemptId: connectionAttemptId,
    }
  }

  function emitBridgeTelemetry() {
    sendToBrowser(browserWs, { type: 'bridge_telemetry', bridge: bridgeSnapshot(), timestamp: Date.now() })
  }

  function sendDeepgramJson(connection, msg) {
    if (!isDeepgramOpen(connection)) return false
    connection.socket.send(JSON.stringify(msg))
    return true
  }

  function sendDeepgramAudio(connection, data) {
    if (!isDeepgramOpen(connection)) return false
    connection.socket.send(data)
    lastUpstreamAudioAt = Date.now()
    return true
  }

  // A socket is current if it is the one we hold and its attempt has not been
  // superseded. This is the WHOLE staleness test. It used to also compare a
  // closure-captured epoch against activeEpoch, which is what welded the epoch to the
  // socket; connection identity already rejects every retired socket, so nothing is
  // lost by dropping the epoch from this check.
  function connectionIsCurrent(connection, attemptId) {
    return connection === dg && attemptId === connectionAttemptId
  }

  function attachDeepgramConnection(connection, epoch, attemptId) {
    dg = connection

    connection.on('open', () => {
      if (!connectionIsCurrent(connection, attemptId)) {
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
      } else {
        // 'stale' — the transition was superseded before this socket opened, so no
        // epoch_ready goes out for `epoch`. The client's audio gate stays shut on
        // that epoch and nothing retries it; only `status: connected` below is sent,
        // which does NOT open the gate. This was silent.
        console.warn(`[deepgram-sdk-bridge] epoch_ready SUPPRESSED (stale transition) epoch=${epoch} activeEpoch=${activeEpoch} attemptId=${attemptId}/${connectionAttemptId}`)
      }
      sendToBrowser(browserWs, { type: 'status', status: 'connected', implementation: 'sdk', epoch })
      // Clear before re-arming: without this, an `open` that fires twice on one socket
      // (the SDK carries its own reconnectAttempts) orphans the previous 3s interval,
      // which then keeps a dead session alive forever and defeats the idle cutoff.
      clearInterval(keepAliveInterval)
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
      if (!connectionIsCurrent(connection, attemptId)) return
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0]
        if (!alt || !alt.transcript) return
        const text = alt.transcript.trim()
        if (!text) return

        lastSpeechAt = Date.now() // speech activity → keep the upstream session alive
        lastTranscriptAt = lastSpeechAt
        if (msg.is_final) { pendingFinalSince = 0; interimOutstanding = false }
        else { if (!pendingFinalSince) pendingFinalSince = lastTranscriptAt; interimOutstanding = true }
        // THE BOUNDARY THAT KEEPS ONE MESSAGE'S TAIL OUT OF THE NEXT — do not collapse
        // this to `activeEpoch`. When an epoch advances mid-utterance, Deepgram keeps
        // finishing the OLD one for a moment; those results describe audio he spoke
        // before he hit send, so they carry the old epoch and the client drops them at
        // voice.mjs:2242. Stamping them with the new epoch is what made the tail of one
        // message reappear as the head of the next.
        //
        // The release is this is_final — the utterance's own end, a content boundary.
        // Inclusive: the final itself still belongs to the utterance it closes.
        const stamped = carriedEpoch ?? activeEpoch
        if (msg.is_final) releaseCarriedEpoch('final')
        console.log(`[deepgram-sdk-bridge] transcript: is_final=${msg.is_final} speech_final=${msg.speech_final} from_finalize=${msg.from_finalize} epoch=${stamped} "${text.slice(0, 60)}"`)
        sendToBrowser(browserWs, {
          type: 'transcript',
          text,
          is_final: msg.is_final || false,
          speech_final: msg.speech_final || false,
          from_finalize: msg.from_finalize || false,
          timestamp: Date.now(),
          epoch: stamped,
        })
        emitBridgeTelemetry()
        return
      }

      if (msg.type === 'SpeechStarted') {
        lastSpeechAt = Date.now()
        // New speech beginning is a content signal that the previous utterance is done
        // with — the same class of boundary as its is_final, and it arrives exactly when
        // holding would start costing him words. Releasing here can let a late final from
        // the old utterance through as a duplicate, which is the trade we want: he is
        // audibly talking, so swallowing what he is saying now is the worse outcome.
        releaseCarriedEpoch('speech started')
        pendingFinalSince = pendingFinalSince || lastSpeechAt
        console.log('[deepgram-sdk-bridge] speech started')
        sendToBrowser(browserWs, { type: 'speech_started', timestamp: Date.now(), epoch: activeEpoch })
        emitBridgeTelemetry()
        return
      }

      if (msg.type === 'UtteranceEnd') {
        pendingFinalSince = 0
        interimOutstanding = false
        // Another real end-of-utterance boundary. If we are still carrying (no is_final
        // ever arrived), release forward here rather than wait for the backstop.
        releaseCarriedEpoch('utterance end')
        sendToBrowser(browserWs, { type: 'utterance_end', timestamp: Date.now(), epoch: activeEpoch })
        emitBridgeTelemetry()
        return
      }

      if (msg.type === 'Metadata') {
        sendToBrowser(browserWs, { type: 'metadata', request_id: msg.request_id, timestamp: Date.now() })
      }
    })

    connection.on('close', (event) => {
      // Identity only. Comparing the closure epoch here would now silently swallow the
      // close of a socket whose epoch advanced while it was alive — leaving `dg` set to
      // a dead connection and never counting the drop.
      if (!connectionIsCurrent(connection, attemptId)) return
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
      emitBridgeTelemetry()
    })

    connection.on('error', (err) => {
      if (!connectionIsCurrent(connection, attemptId)) return
      console.error('[deepgram-sdk-bridge] Deepgram error:', err.message)
      sendToBrowser(browserWs, { type: 'status', status: 'error', error: err.message, implementation: 'sdk', epoch: activeEpoch, attemptId })
    })
  }

  async function connectDeepgram(epoch = activeEpoch) {
    if (dg || connecting) {
      if (!dg) logDiscard('connect-inflight', 'connect request joined an in-flight attempt', { epoch, activeEpoch })
      return connecting
    }
    const attemptId = ++connectionAttemptId
    // STORM GUARD — reconnects only happen here (driven by real audio or an
    // explicit `start`), never on a self-scheduled timer. After a failure/drop we
    // back off exponentially, so a session Deepgram keeps closing (its no-audio
    // timeout, a 402, etc.) can't loop — that loop was the 555K-reconnect storm.
    // An explicit `start` resets reconnectFailures, so user intent connects now.
    const backoff = reconnectFailures > 0 ? Math.min(30000, 1000 * 2 ** (reconnectFailures - 1)) : 0
    if (backoff && Date.now() - lastConnectAt < backoff) {
      // Returns null with no connection and no message to the client. Callers that
      // were waiting to flush audio silently drop it (see the pending-frame path).
      logDiscard('connect-backoff', 'connect throttled by backoff', {
        epoch, backoffMs: backoff, sinceLastMs: Date.now() - lastConnectAt, reconnectFailures,
      })
      return null
    }
    lastConnectAt = Date.now()
    // A fresh connect (incl. voice OFF→ON after a stop-triggered disconnect)
    // re-arms auto-reconnect: clear the manual-close flag set by disconnectDeepgram().
    manuallyClosed = false
    connecting = (async () => {
      const connection = await client.listen.v1.connect(listenOptions(clientVoiceParams))
      // Attempt id is the single staleness notion. Every path that moves the epoch while
      // a connect is in flight goes through retireEpoch(), which bumps the attempt id —
      // so this covers what the old epoch comparison covered, without a second concept
      // of "stale" that can disagree with the first.
      if (attemptId !== connectionAttemptId) {
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
      } else {
        // The connect failed for an epoch/attempt that has since been superseded, so
        // the client is told nothing at all. If its gate was waiting on THIS epoch it
        // waits forever. Silent before this line.
        console.warn(`[deepgram-sdk-bridge] connect-failed NOT reported to client (superseded) epoch=${epoch}/${activeEpoch} attemptId=${attemptId}/${connectionAttemptId}: ${err.message}`)
      }
      if (epoch === activeEpoch && attemptId === connectionAttemptId) {
        sendToBrowser(browserWs, { type: 'status', status: 'error', error: err.message, implementation: 'sdk', epoch, attemptId })
      }
      emitBridgeTelemetry()
      return null
    })
    return connecting
  }

  // Close the upstream session because Deepgram saw no speech for IDLE_CUTOFF_MS.
  // Marks idleClosed so we won't auto-reconnect and so incoming audio is dropped
  // until the client explicitly sends `start` again (no flap on a quiet mic).
  function idleCutoff() {
    // `no speech` here means Deepgram reported no speech. lastSpeechAt is advanced ONLY
    // by an upstream open, a non-empty transcript, or SpeechStarted — audio frames do
    // not touch it. So this line firing while audio is arriving is not a quiet mic; it
    // means frames are reaching us and not producing speech events, which is the
    // discard, not the cause. `audioAgoMs` is what separates the two, and it was
    // missing. (It also printed the global IDLE_CUTOFF_MS while checking per-connection
    // idleMs — they differ whenever the client sends its own.)
    const audioAgo = lastBrowserAudioAt ? Date.now() - lastBrowserAudioAt : null
    console.log(`[deepgram-sdk-bridge] idle cutoff — no speech for ${idleMs}ms, closing upstream (audioAgoMs=${audioAgo} activeEpoch=${activeEpoch} transition=${epochTransition?.state ?? 'none'} droppedChunks=${droppedChunks})`)
    idleClosed = true
    disconnectDeepgram()
    sendToBrowser(browserWs, { type: 'status', status: 'idle', implementation: 'sdk', epoch: activeEpoch, attemptId: connectionAttemptId })
    emitBridgeTelemetry()
  }

  function disconnectDeepgram() {
    manuallyClosed = true
    releaseCarriedEpoch('upstream disconnected')
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
      lastBrowserAudioAt = Date.now()
      if (epochTransition?.state === 'connecting') {
        const maxBytes = epochQueueMaxBytes()
        if (!enqueueEpochPcm(epochTransition, frame, maxBytes)) {
          revokeConnectionAttempt('overflowed epoch')
          emitEpochLoss(epochTransition, 'queue-overflow', frame.length)
          droppedChunks++
          epochTransition.state = 'recovering'
          sendToBrowser(browserWs, { type: 'epoch_error', epoch: epochTransition.epoch, reason: 'queue-overflow' })
          emitBridgeTelemetry()
          return
        }
        return
      }
      if (epochTransition?.state === 'recovering') {
        droppedChunks++
        // This is a silent discard of the user's speech, and it was invisible: a
        // counter plus telemetry, no log line and no message to the client. The
        // client meanwhile is sending happily, so its own heartbeat reads healthy.
        // `recovering` is only left on a new, strictly-higher epoch — i.e. it does
        // not self-heal, it waits for the user to restart.
        logDiscard('recovering-drop', 'DROPPED audio frame (epoch transition recovering)', {
          epoch: epochTransition.epoch, bytes: frame.length, droppedChunks,
        })
        emitBridgeTelemetry()
        return
      }
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
          if (!connection || browserWs.readyState !== WebSocket.OPEN) {
            // The reconnect that his first words after a pause were waiting on did not
            // happen, so the pre-roll AND those words are discarded. Silent before this.
            droppedChunks += frames.length
            logDiscard('resume-no-connection', 'DROPPED preroll + speech (resume connect returned no connection)', {
              frames: frames.length, browserWsOpen: browserWs.readyState === WebSocket.OPEN, droppedChunks,
            })
            emitBridgeTelemetry()
            return
          }
          for (const f of frames) {
            try {
              if (sendDeepgramAudio(connection, f)) flushedChunks++
            } catch (err) {
              console.warn('[deepgram-sdk-bridge] preroll audio send failed:', err.message)
              droppedChunks++
            }
          }
          emitBridgeTelemetry()
        })
        return
      }
      if (isDeepgramOpen()) {
        try { sendDeepgramAudio(dg, data) } catch (err) { console.warn('[deepgram-sdk-bridge] audio send failed:', err.message) }
        return
      }
      const pending = Buffer.from(data)
      connectDeepgram().then(connection => {
        if (!connection || browserWs.readyState !== WebSocket.OPEN) {
          // Was dropped without even incrementing droppedChunks, so it did not show
          // up in telemetry either. Reached when connectDeepgram resolves null
          // (throttled or superseded).
          droppedChunks++
          logDiscard('pending-no-connection', 'DROPPED audio frame (no connection after connect attempt)', {
            bytes: pending.length, browserWsOpen: browserWs.readyState === WebSocket.OPEN, droppedChunks,
          })
          emitBridgeTelemetry()
          return
        }
        try {
          if (!sendDeepgramAudio(connection, pending)) {
            console.warn('[deepgram-sdk-bridge] pending audio dropped: socket not open')
            droppedChunks++
          } else {
            flushedChunks++
          }
        } catch (err) {
          console.warn('[deepgram-sdk-bridge] pending audio send failed:', err.message)
          droppedChunks++
        }
        emitBridgeTelemetry()
      })
      return
    }

    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'speech_epoch') {
        if (!acceptsSpeechEpoch(activeEpoch, msg.epoch)) {
          // The client has no recovery for epoch_error other than epoch_loss, so this
          // leaves it PCM-paused with no way back short of a restart. Record it.
          console.warn(`[deepgram-sdk-bridge] REJECTED speech_epoch (non-monotone) requested=${msg.epoch} activeEpoch=${activeEpoch}`)
          sendToBrowser(browserWs, { type: 'epoch_error', epoch: msg.epoch, reason: 'non-monotone-epoch' })
          return
        }
        // ONE path for advancing the epoch on a healthy session: keep the socket.
        // This used to call retireEpoch('superseded') + connectDeepgram() every time,
        // which redialed Deepgram after every message he sent. Nothing about a new
        // epoch requires a new socket now that the epoch is session state.
        if (isDeepgramOpen()) {
          advanceEpochOnLiveSocket(msg.epoch)
          return
        }
        // No live upstream (first epoch of a session, or after an idle cutoff) — there
        // is nothing to flush, so connect and let `open` acknowledge the epoch.
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
      } else if (msg.type === 'stop') {
        // Voice OFF must end the upstream Deepgram session, or it stays open
        // (held by the 3 s KeepAlive) and keeps billing. The client tears down
        // the mic on stop but leaves this WS open for a later 'start', so tab
        // close is NOT a reliable end-of-session — disconnect upstream here.
        disconnectDeepgram()
      } else if (msg.type === 'log') {
        console.log(`[voice] ${msg.text}`)
      }
    } catch (err) {
      // This was a bare `catch {}`. The epoch_ready send at the end of
      // advanceEpochOnLiveSocket runs inside this try, after a Finalize send that can
      // throw — so a throw here left the client's audio gate shut with no epoch_error,
      // no log, nothing. That is one of the two states we could not tell apart.
      console.error(`[deepgram-sdk-bridge] browser message handler threw: ${err?.message}`, err?.stack)
    }
  })

  browserWs.on('close', () => {
    console.log(`[deepgram-sdk-bridge] browser disconnected (${wss.clients.size} total)`)
    disconnectDeepgram()
  })
})

process.on('SIGINT', () => process.exit())
process.on('SIGTERM', () => process.exit())
