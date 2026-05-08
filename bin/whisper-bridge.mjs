#!/usr/bin/env node
// whisper-bridge.mjs — Bridges whisper-stream stdout to a WebSocket server.
// Browser connects to ws://localhost:8179, receives transcription text in real-time.
//
// Usage: node bin/whisper-bridge.mjs [--model /path/to/model.bin] [--port 8179]

import { spawn } from 'child_process'
import { WebSocketServer } from 'ws'
import { createInterface } from 'readline'

const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : '/opt/homebrew/share/whisper-cpp/ggml-small.en.bin'
const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 8179

// Start whisper-stream
const whisper = spawn('whisper-stream', [
  '-m', MODEL,
  '--step', '3000',
  '--length', '10000',
  '--keep', '200',
  '-kc',           // keep context between chunks
  '--language', 'en',
], { stdio: ['ignore', 'pipe', 'pipe'] })

console.log(`[bridge] whisper-stream started (pid ${whisper.pid})`)

whisper.on('error', (err) => {
  console.error(`[bridge] whisper-stream failed to start: ${err.message}`)
  process.exit(1)
})

whisper.on('exit', (code) => {
  console.log(`[bridge] whisper-stream exited (code ${code})`)
  process.exit(code || 0)
})

// Parse whisper-stream output
// whisper-stream uses ANSI escape codes: \x1b[2K clears line, then prints text.
// Final results end with a newline. Interim results are overwritten.
const rl = createInterface({ input: whisper.stdout })

let lastText = ''
let flushUntil = 0  // drop output until this timestamp (set on flush)

rl.on('line', (raw) => {
  // Strip ANSI escape codes
  const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
  if (!clean) return
  if (clean === '[BLANK_AUDIO]') return
  if (clean === '[Start speaking]') return
  if (clean.startsWith('main:')) return
  // Filter whisper silence hallucinations (trained on YouTube, hallucinates these)
  if (/subscribe|like and subscribe|thanks for watching|thank you for watching|please subscribe|my channel/i.test(clean)) return
  if (/^\.*$/.test(clean)) return  // just dots
  if (/^[.!?,\s]+$/.test(clean)) return  // just punctuation

  // After a flush, drop all output for one full processing window (step + length).
  // This ensures old audio that was in whisper-stream's buffer before the flush
  // doesn't produce text that overwrites the user's edits.
  const now = Date.now()
  if (now < flushUntil) return

  if (clean !== lastText) {
    lastText = clean
    broadcast(JSON.stringify({ type: 'transcript', text: clean, timestamp: now }))
  }
})

// Also capture stderr for whisper model loading messages
whisper.stderr.on('data', (data) => {
  const line = data.toString().trim()
  if (line && !line.startsWith('load_backend') && !line.startsWith('ggml_') && !line.startsWith('whisper_'))
    console.log(`[whisper] ${line}`)
})

// WebSocket server
const wss = new WebSocketServer({ port: PORT })
console.log(`[bridge] WebSocket server on ws://localhost:${PORT}`)

function broadcast(msg) {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg)
  }
}

wss.on('connection', (ws) => {
  console.log(`[bridge] client connected (${wss.clients.size} total)`)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'flush') {
        lastText = ''
        // Drop output for step + processing time (~4s) so old audio
        // in whisper-stream's buffer doesn't leak through.
        flushUntil = Date.now() + 4000
        console.log(`[bridge] flush — dropping output for 4s`)
      }
      if (msg.type === 'log') {
        console.log(`[voice] ${msg.text}`)
      }
    } catch {}
  })
  ws.on('close', () => console.log(`[bridge] client disconnected (${wss.clients.size} total)`))
})

// Clean shutdown
process.on('SIGINT', () => { whisper.kill(); process.exit() })
process.on('SIGTERM', () => { whisper.kill(); process.exit() })
