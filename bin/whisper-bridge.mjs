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

rl.on('line', (raw) => {
  // Strip ANSI escape codes
  const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
  if (!clean) return
  if (clean === '[BLANK_AUDIO]') return
  if (clean === '[Start speaking]') return
  if (clean.startsWith('main:')) return

  // Dedup: only send the NEW portion that wasn't in the previous output.
  // whisper-stream re-outputs overlapping text from the --keep window.
  if (clean !== lastText) {
    let newText = clean
    if (lastText) {
      // Find the longest suffix of lastText that matches a prefix of clean
      for (let i = Math.min(lastText.length, clean.length); i > 0; i--) {
        if (clean.startsWith(lastText.slice(-i))) {
          newText = clean.slice(i).trim()
          break
        }
      }
    }
    lastText = clean
    if (newText) {
      broadcast(JSON.stringify({ type: 'transcript', text: newText, timestamp: Date.now() }))
    }
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
  ws.on('close', () => console.log(`[bridge] client disconnected (${wss.clients.size} total)`))
})

// Clean shutdown
process.on('SIGINT', () => { whisper.kill(); process.exit() })
process.on('SIGTERM', () => { whisper.kill(); process.exit() })
