#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const port = 18000 + Math.floor(Math.random() * 1000)
const captureDir = mkdtempSync(join(tmpdir(), 'tlda-voice-capture-'))
const bridge = spawn(process.execPath, [
  'bin/deepgram-bridge.mjs',
  '--validate-audio',
  '--port', String(port),
  '--capture-dir', captureDir,
], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
function waitForOutput(pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; output:\n${output}`)), timeoutMs)
    const check = () => {
      if (pattern.test(output)) {
        clearTimeout(timer)
        resolve()
      }
    }
    bridge.stdout.on('data', (d) => { output += d.toString(); check() })
    bridge.stderr.on('data', (d) => { output += d.toString(); check() })
    check()
  })
}

try {
  await waitForOutput(/WebSocket server on ws?s:\/\/localhost:/)

  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
    socket.on('open', () => resolve(socket))
    socket.on('error', reject)
  })

  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch {}
  })

  ws.send(JSON.stringify({ type: 'start' }))
  ws.send(Buffer.alloc(3200, 1), { binary: true })
  ws.send(Buffer.alloc(3200, 2), { binary: true })
  ws.send(JSON.stringify({ type: 'stop' }))

  const saved = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for validation_saved; messages=${JSON.stringify(messages)}`)), 3000)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'validation_saved') {
          clearTimeout(timer)
          resolve(msg)
        }
      } catch {}
    })
  })
  ws.close()

  assert.equal(saved.bytes, 6400)
  assert.equal(saved.chunks, 2)
  assert.ok(existsSync(saved.raw_path), 'raw capture should exist')
  assert.ok(existsSync(saved.wav_path), 'wav capture should exist')
  assert.equal(readFileSync(saved.raw_path).length, 6400)
  const wav = readFileSync(saved.wav_path)
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE')
  assert.equal(wav.readUInt32LE(40), 6400)

  console.log('✓ deepgram bridge validate-audio writes raw/WAV captures')
} finally {
  bridge.kill('SIGTERM')
  rmSync(captureDir, { recursive: true, force: true })
}
