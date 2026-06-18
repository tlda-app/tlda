#!/usr/bin/env node
// deepgram-bridge.mjs — Bridges browser mic audio to Deepgram's streaming API.
// Browser connects to ws://localhost:8179, sends raw PCM audio, receives transcripts.
//
// Usage:
//   node bin/deepgram-bridge.mjs [--port 8179] [--key DEEPGRAM_API_KEY]
//   node bin/deepgram-bridge.mjs --validate-audio [--port 8179] [--capture-dir DIR]
//
// The API key is resolved in order: --key flag > DEEPGRAM_API_KEY env > ~/.config/tlda/config.json

import { WebSocketServer, WebSocket } from 'ws'
import { createServer as createHttpsServer } from 'https'
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadConfig } from '../shared/config.mjs'

const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 8179
const VALIDATE_AUDIO = process.argv.includes('--validate-audio')
const CAPTURE_DIR = process.argv.includes('--capture-dir')
  ? process.argv[process.argv.indexOf('--capture-dir') + 1]
  : join(process.env.HOME || homedir(), '.config', 'tlda', 'voice-captures')

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
if (!API_KEY && !VALIDATE_AUDIO) {
  console.error('[deepgram-bridge] No API key found. Set DEEPGRAM_API_KEY, use --key, or add deepgramApiKey to ~/.config/tlda/config.json')
  process.exit(1)
}

// Keywords for math/stats domain — boosted in Deepgram's recognition
const KEYWORDS = [
  'Bregman', 'estimand', 'estimands', 'Riesz', 'RKHS', 'Hilbert',
  'Sobolev', 'Matérn', 'semiparametric', 'minimax', 'nuisance',
  'Donoho', 'Hirshberg', 'Wager', 'AMLE',
  'theta', 'phi', 'gamma', 'psi', 'tau', 'eta', 'chi', 'xi', 'zeta',
  'mu', 'nu', 'rho', 'sigma', 'lambda', 'epsilon', 'delta', 'alpha', 'beta',
  'lemma', 'seminorm', 'asymptotic', 'doubly robust', 'cross-fitting',
  'kernel balancing', 'synthetic control', 'kernel ridge',
]

function buildDeepgramUrl() {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  })
  for (const kw of KEYWORDS) {
    params.append('keyterm', kw)
  }
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`
}

// Track active Deepgram connections per browser client
const clientSessions = new Map()

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
  console.log(`[deepgram-bridge] WebSocket server on wss://localhost:${PORT}`)
} else {
  wss = new WebSocketServer({ port: PORT })
  console.log(`[deepgram-bridge] WebSocket server on ws://localhost:${PORT}`)
}
console.log(`[deepgram-bridge] Using ${KEYWORDS.length} keyword boosts`)
if (VALIDATE_AUDIO) {
  mkdirSync(CAPTURE_DIR, { recursive: true })
  console.log(`[deepgram-bridge] validate-audio mode; saving captures to ${CAPTURE_DIR}`)
}

function broadcast(msg) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg)
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str)
  }
}

function wavHeader({ byteLength, sampleRate = 16000, channels = 1, bitsPerSample = 16 }) {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * bitsPerSample / 8
  const blockAlign = channels * bitsPerSample / 8
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + byteLength, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(byteLength, 40)
  return header
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

wss.on('connection', (browserWs) => {
  console.log(`[deepgram-bridge] browser connected (${wss.clients.size} total)`)

  let dgWs = null
  let keepAliveInterval = null
  let audioStartedAt = 0
  let audioLastAt = 0
  let audioBytes = 0
  let audioChunks = 0
  let audioMaxGapMs = 0
  let audioGapCount = 0
  let audioEmptyFrames = 0
  const audioBuffers = []

  function audioStats(extra = {}) {
    const elapsedMs = audioStartedAt ? Math.max(1, audioLastAt - audioStartedAt) : 0
    const expectedBytes = elapsedMs ? Math.round(16000 * 2 * elapsedMs / 1000) : 0
    return {
      type: 'audio_stats',
      bytes: audioBytes,
      chunks: audioChunks,
      elapsed_ms: elapsedMs,
      expected_bytes: expectedBytes,
      ratio_to_realtime: expectedBytes ? audioBytes / expectedBytes : null,
      max_gap_ms: audioMaxGapMs,
      gaps_over_250ms: audioGapCount,
      empty_frames: audioEmptyFrames,
      ...extra,
    }
  }

  function saveValidationCapture(reason) {
    if (!VALIDATE_AUDIO || audioBytes === 0) return null
    mkdirSync(CAPTURE_DIR, { recursive: true })
    const base = join(CAPTURE_DIR, `voice-${timestampForFilename()}`)
    const raw = Buffer.concat(audioBuffers, audioBytes)
    const rawPath = `${base}.raw`
    const wavPath = `${base}.wav`
    writeFileSync(rawPath, raw)
    writeFileSync(wavPath, Buffer.concat([wavHeader({ byteLength: raw.length }), raw]))
    const stats = audioStats({ reason, raw_path: rawPath, wav_path: wavPath })
    writeFileSync(`${base}.json`, JSON.stringify(stats, null, 2) + '\n')
    console.log(`[deepgram-bridge] validate saved ${audioBytes} bytes (${audioChunks} chunks) to ${wavPath}`)
    try { browserWs.send(JSON.stringify({ ...stats, type: 'validation_saved' })) } catch {}
    return stats
  }

  function connectDeepgram() {
    if (dgWs && (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING)) return

    const url = buildDeepgramUrl()
    dgWs = new WebSocket(url, {
      headers: { Authorization: `Token ${API_KEY}` },
    })

    dgWs.on('open', () => {
      console.log('[deepgram-bridge] connected to Deepgram')
      broadcast({ type: 'status', status: 'connected' })
      // Deepgram requires periodic keepalives
      keepAliveInterval = setInterval(() => {
        if (dgWs?.readyState === WebSocket.OPEN) {
          dgWs.send(JSON.stringify({ type: 'KeepAlive' }))
        }
      }, 3000)
    })

    dgWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())

        if (msg.type === 'Results') {
          const alt = msg.channel?.alternatives?.[0]
          if (!alt || !alt.transcript) return

          const text = alt.transcript.trim()
          if (!text) return

          console.log(`[deepgram-bridge] transcript: is_final=${msg.is_final} speech_final=${msg.speech_final} "${text.slice(0, 60)}"`)

          broadcast({
            type: 'transcript',
            text,
            is_final: msg.is_final || false,
            speech_final: msg.speech_final || false,
            timestamp: Date.now(),
          })
        }

        if (msg.type === 'SpeechStarted') {
          console.log('[deepgram-bridge] speech started')
          broadcast({ type: 'speech_started', timestamp: Date.now() })
        }

        if (msg.type === 'UtteranceEnd') {
          broadcast({ type: 'utterance_end', timestamp: Date.now() })
        }
      } catch (err) {
        console.warn('[deepgram-bridge] parse error:', err.message)
      }
    })

    dgWs.on('close', (code, reason) => {
      console.log(`[deepgram-bridge] Deepgram closed: ${code} ${reason}`)
      clearInterval(keepAliveInterval)
      keepAliveInterval = null
      dgWs = null
      // Auto-reconnect if the browser is still connected — don't wait for next audio chunk
      if (browserWs.readyState === WebSocket.OPEN) {
        setTimeout(() => {
          if (browserWs.readyState === WebSocket.OPEN && !dgWs) {
            console.log('[deepgram-bridge] auto-reconnecting to Deepgram')
            connectDeepgram()
          }
        }, 1000)
      }
    })

    dgWs.on('error', (err) => {
      console.error('[deepgram-bridge] Deepgram error:', err.message)
      broadcast({ type: 'status', status: 'error', error: err.message })
    })
  }

  function disconnectDeepgram() {
    clearInterval(keepAliveInterval)
    keepAliveInterval = null
    if (dgWs) {
      // Send CloseStream message for clean shutdown
      if (dgWs.readyState === WebSocket.OPEN) {
        try { dgWs.send(JSON.stringify({ type: 'CloseStream' })) } catch {}
      }
      dgWs.onclose = null
      dgWs.close()
      dgWs = null
    }
  }

  browserWs.on('message', (data, isBinary) => {
    // ws v8+ delivers all incoming messages as Buffer regardless of frame
    // type; the `isBinary` flag is the only reliable discriminator. Without
    // it, text control messages ({type:'log'}, {type:'stop'}, etc.) get
    // treated as audio and forwarded to Deepgram instead of being handled
    // here — silently. The `start`/connectDeepgram effect happened to fall
    // out of the audio path so things mostly looked right, but log + stop +
    // flush never worked.
    if (isBinary) {
      if (VALIDATE_AUDIO) {
        const chunk = Buffer.from(data)
        if (chunk.length === 0) {
          audioEmptyFrames++
          console.warn('[deepgram-bridge] validate received empty audio frame')
          return
        }
        const now = Date.now()
        if (audioLastAt) {
          const gap = now - audioLastAt
          audioMaxGapMs = Math.max(audioMaxGapMs, gap)
          if (gap > 250) {
            audioGapCount++
            console.warn(`[deepgram-bridge] validate audio gap ${gap}ms`)
          }
        }
        if (!audioStartedAt) audioStartedAt = now
        audioLastAt = now
        audioBytes += chunk.length
        audioChunks++
        audioBuffers.push(chunk)
        if (audioChunks === 1 || audioChunks % 50 === 0) {
          const stats = audioStats()
          console.log(`[deepgram-bridge] validate audio bytes=${stats.bytes} chunks=${stats.chunks} ratio=${stats.ratio_to_realtime?.toFixed?.(2) ?? 'n/a'}`)
          try { browserWs.send(JSON.stringify(stats)) } catch {}
        }
        return
      }
      if (!dgWs || dgWs.readyState !== WebSocket.OPEN) {
        connectDeepgram()
        const pending = Buffer.from(data)
        const waitForOpen = () => {
          if (dgWs?.readyState === WebSocket.OPEN) {
            dgWs.send(pending)
          } else {
            setTimeout(waitForOpen, 50)
          }
        }
        setTimeout(waitForOpen, 50)
        return
      }
      dgWs.send(data)
      return
    }

    // Text data = control messages from browser
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'start') {
        if (VALIDATE_AUDIO) {
          browserWs.send(JSON.stringify({ type: 'status', status: 'validating_audio', capture_dir: CAPTURE_DIR }))
          return
        }
        connectDeepgram()
      } else if (msg.type === 'finalize' || msg.type === 'flush') {
        if (dgWs?.readyState === WebSocket.OPEN) {
          try { dgWs.send(JSON.stringify({ type: 'Finalize' })) } catch {}
        }
      } else if (msg.type === 'stop') {
        if (VALIDATE_AUDIO) saveValidationCapture('stop')
        // Keep the session warm; rely on the browserWs close to end it.
      } else if (msg.type === 'log') {
        console.log(`[voice] ${msg.text}`)
      }
    } catch {}
  })

  browserWs.on('close', () => {
    console.log(`[deepgram-bridge] browser disconnected (${wss.clients.size} total)`)
    saveValidationCapture('browser-close')
    disconnectDeepgram()
  })

  clientSessions.set(browserWs, { dgWs: null })
})

process.on('SIGINT', () => process.exit())
process.on('SIGTERM', () => process.exit())
