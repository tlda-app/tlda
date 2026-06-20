#!/usr/bin/env node
// deepgram-sdk-bridge.mjs — SDK-backed sibling of deepgram-bridge.mjs.
// Browser connects to ws://localhost:8180, sends raw PCM audio, receives the
// same transcript/status JSON contract as the raw WebSocket bridge.
//
// Usage:
//   node bin/deepgram-sdk-bridge.mjs [--port 8180] [--key DEEPGRAM_API_KEY]

import { DeepgramClient } from '@deepgram/sdk'
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

function listenOptions() {
  const overrides = loadVoiceParamOverrides()
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

function broadcast(msg) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg)
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str)
  }
}

wss.on('connection', (browserWs) => {
  console.log(`[deepgram-sdk-bridge] browser connected (${wss.clients.size} total)`)

  const client = new DeepgramClient({ apiKey: API_KEY })
  let dg = null
  let connecting = null
  let keepAliveInterval = null
  let manuallyClosed = false

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

  function attachDeepgramConnection(connection) {
    dg = connection

    connection.on('open', () => {
      console.log('[deepgram-sdk-bridge] connected to Deepgram')
      broadcast({ type: 'status', status: 'connected', implementation: 'sdk' })
      keepAliveInterval = setInterval(() => {
        try { sendDeepgramJson(dg, { type: 'KeepAlive' }) } catch {}
      }, 3000)
    })

    connection.on('message', (msg) => {
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0]
        if (!alt || !alt.transcript) return
        const text = alt.transcript.trim()
        if (!text) return

        console.log(`[deepgram-sdk-bridge] transcript: is_final=${msg.is_final} speech_final=${msg.speech_final} from_finalize=${msg.from_finalize} "${text.slice(0, 60)}"`)
        broadcast({
          type: 'transcript',
          text,
          is_final: msg.is_final || false,
          speech_final: msg.speech_final || false,
          from_finalize: msg.from_finalize || false,
          timestamp: Date.now(),
        })
        return
      }

      if (msg.type === 'SpeechStarted') {
        console.log('[deepgram-sdk-bridge] speech started')
        broadcast({ type: 'speech_started', timestamp: Date.now() })
        return
      }

      if (msg.type === 'UtteranceEnd') {
        broadcast({ type: 'utterance_end', timestamp: Date.now() })
        return
      }

      if (msg.type === 'Metadata') {
        broadcast({ type: 'metadata', request_id: msg.request_id, timestamp: Date.now() })
      }
    })

    connection.on('close', (event) => {
      console.log(`[deepgram-sdk-bridge] Deepgram closed: ${event?.code ?? ''} ${event?.reason ?? ''}`)
      clearInterval(keepAliveInterval)
      keepAliveInterval = null
      dg = null
      connecting = null
      if (!manuallyClosed && browserWs.readyState === WebSocket.OPEN) {
        setTimeout(() => {
          if (!dg && browserWs.readyState === WebSocket.OPEN) connectDeepgram()
        }, 1000)
      }
    })

    connection.on('error', (err) => {
      console.error('[deepgram-sdk-bridge] Deepgram error:', err.message)
      broadcast({ type: 'status', status: 'error', error: err.message, implementation: 'sdk' })
    })
  }

  async function connectDeepgram() {
    if (dg || connecting) return connecting
    connecting = (async () => {
      const connection = await client.listen.v1.connect(listenOptions())
      attachDeepgramConnection(connection)
      connection.connect()
      await connection.waitForOpen()
      return connection
    })().catch(err => {
      connecting = null
      console.error('[deepgram-sdk-bridge] connect failed:', err.message)
      try { browserWs.send(JSON.stringify({ type: 'status', status: 'error', error: err.message, implementation: 'sdk' })) } catch {}
      return null
    })
    return connecting
  }

  function disconnectDeepgram() {
    manuallyClosed = true
    clearInterval(keepAliveInterval)
    keepAliveInterval = null
    if (dg) {
      try { sendDeepgramJson(dg, { type: 'CloseStream' }) } catch {}
      try { dg.close() } catch {}
      dg = null
    }
  }

  browserWs.on('message', (data, isBinary) => {
    if (isBinary) {
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
      if (msg.type === 'start') {
        connectDeepgram()
      } else if (msg.type === 'finalize' || msg.type === 'flush') {
        try { sendDeepgramJson(dg, { type: 'Finalize' }) } catch {}
      } else if (msg.type === 'stop') {
        // Keep the upstream session warm; browser close ends the session.
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
