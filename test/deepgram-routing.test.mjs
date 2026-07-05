// Proves Deepgram bridge transcripts are scoped to the browser connection whose
// upstream Deepgram session produced them. This guards against cross-device echo:
// one device's transcript must not fan out to another browser session.

import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'

const PORT = 8196
const tlsDir = join(homedir(), '.config/tlda')
const useTls = existsSync(join(tlsDir, 'localhost+2.pem')) && existsSync(join(tlsDir, 'localhost+2-key.pem'))
const proto = useTls ? 'wss' : 'ws'

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function waitFor(pred, ms = 3000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(true) }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout waiting for ${label}`)) }
    }, 20)
  })
}

async function openClient(messages) {
  const ws = new WebSocket(`${proto}://localhost:${PORT}`, { rejectUnauthorized: false })
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch { /* ignore non-JSON */ }
  })
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  return ws
}

const env = { ...process.env, FAKE_DG_RESULT_ON_AUDIO: 'origin-only routing proof' }
const bridge = spawn(process.execPath, [
  '--import', './test/deepgram-fake-register.mjs',
  'bin/deepgram-sdk-bridge.mjs', '--port', String(PORT), '--key', 'fake-key', '--idle-ms', '60000',
], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env })

const fakeLines = []
bridge.stdout.on('data', (b) => {
  for (const ln of b.toString().split('\n')) if (ln.startsWith('FAKE:')) fakeLines.push(ln.slice(5))
})
bridge.stderr.on('data', (b) => { if (process.env.DEBUG) process.stderr.write(b) })

function cleanup(code) { try { bridge.kill('SIGKILL') } catch { /* already exited */ } process.exit(code) }

try {
  await sleep(500)

  const aMessages = []
  const bMessages = []
  const wsA = await openClient(aMessages)
  const wsB = await openClient(bMessages)

  wsA.send(JSON.stringify({ type: 'start' }))
  wsB.send(JSON.stringify({ type: 'start' }))

  await waitFor(() => fakeLines.filter(l => l.startsWith('listen.connect')).length >= 2, 3000, 'two upstream connects')
  await waitFor(
    () => aMessages.some(m => m.type === 'status' && m.status === 'connected') &&
      bMessages.some(m => m.type === 'status' && m.status === 'connected'),
    3000,
    'both clients connected',
  )

  aMessages.length = 0
  bMessages.length = 0

  wsA.send(Buffer.from(new Int16Array([2000, 2000, 2000, 2000]).buffer))
  await waitFor(
    () => aMessages.some(m => m.type === 'transcript' && m.text === 'origin-only routing proof'),
    3000,
    'origin client transcript',
  )
  await sleep(300)

  assert.ok(
    !bMessages.some(m => m.type === 'transcript' && m.text === 'origin-only routing proof'),
    'non-origin client must not receive transcript; got ' + JSON.stringify(bMessages),
  )

  wsA.close()
  wsB.close()
  console.log('PASS: Deepgram transcript from one bridge connection reaches only its originating browser client.')
  cleanup(0)
} catch (err) {
  console.error('FAIL:', err.message)
  cleanup(1)
}
