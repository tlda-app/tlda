// Proves the storm fix + idle cutoff in the bridge, using a faked @deepgram/sdk.
//
//   Test A (storm): when Deepgram closes a session on its own (no-audio/timeout),
//   the bridge does NOT auto-redial — it waits for real audio or an explicit
//   `start`. This is the 555K-reconnect-storm root-cause fix.
//
//   Test B (idle cutoff): after IDLE_CUTOFF_MS with no speech, the bridge closes
//   the upstream session and tells the client (status:idle); further audio is
//   dropped until an explicit `start` (no flap), which then reconnects.
//
// Each test spawns the real bridge with the fake SDK injected and a short
// --idle-ms, drives a real ws client, and asserts on FAKE: stdout (upstream
// actions) and on the browser-side status messages.

import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'

const tlsDir = join(homedir(), '.config/tlda')
const useTls = existsSync(join(tlsDir, 'localhost+2.pem')) && existsSync(join(tlsDir, 'localhost+2-key.pem'))
const proto = useTls ? 'wss' : 'ws'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function runBridge({ port, idleMs, autoCloseMs, fn }) {
  const fakeLines = []
  const statuses = []
  const env = { ...process.env }
  if (autoCloseMs) env.FAKE_DG_AUTOCLOSE_MS = String(autoCloseMs)
  const bridge = spawn(process.execPath, [
    '--import', './test/deepgram-fake-register.mjs',
    'bin/deepgram-sdk-bridge.mjs', '--port', String(port), '--key', 'fake-key', '--idle-ms', String(idleMs),
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env })
  bridge.stdout.on('data', (b) => {
    for (const ln of b.toString().split('\n')) if (ln.startsWith('FAKE:')) fakeLines.push(ln.slice(5))
  })
  bridge.stderr.on('data', (b) => { if (process.env.DEBUG) process.stderr.write(b) })
  try {
    await sleep(500)
    const ws = new WebSocket(`${proto}://localhost:${port}`, { rejectUnauthorized: false })
    ws.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.type === 'status') statuses.push(m.status) } catch {} })
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    await fn({ ws, fakeLines, statuses })
    ws.close()
  } finally {
    bridge.kill('SIGKILL')
  }
  return { fakeLines, statuses }
}

const count = (arr, v) => arr.filter(x => x === v).length
const connects = (arr) => arr.filter(l => l.startsWith('listen.connect')).length

// ── Test A: storm fix — no auto-redial after a Deepgram-initiated close ──────
async function testStorm() {
  const { fakeLines } = await runBridge({
    port: 8191, idleMs: 60000, autoCloseMs: 200,
    fn: async ({ ws }) => {
      ws.send(JSON.stringify({ type: 'start' }))   // one explicit connect
      await sleep(1200)                            // session auto-closes at 200ms; watch for redial
      // NOTE: send no audio and no further start — the bridge must NOT reconnect.
    },
  })
  const nConnects = connects(fakeLines)
  assert.ok(fakeLines.includes('autoclose'), 'fake should have auto-closed the session; lines=' + JSON.stringify(fakeLines))
  assert.equal(nConnects, 1, `bridge must NOT auto-redial after a no-audio close — expected 1 connect, got ${nConnects}: ${JSON.stringify(fakeLines)}`)
  console.log('PASS A (storm): no auto-redial after Deepgram no-audio close (1 connect, then silence).')
}

// ── Test B: idle cutoff + resume-only-on-start ──────────────────────────────
async function testIdle() {
  const { fakeLines, statuses } = await runBridge({
    port: 8192, idleMs: 400, autoCloseMs: 0,
    fn: async ({ ws, fakeLines }) => {
      ws.send(JSON.stringify({ type: 'start' }))
      await sleep(150)
      ws.send(Buffer.from(new Int16Array([5, 5, 5]).buffer)) // some audio, but fake emits no Results → no speech
      // idle cutoff (~400ms no speech) should fire
      await sleep(900)
      const afterIdle = fakeLines.length
      // audio after idle must be DROPPED (no new connect)
      ws.send(Buffer.from(new Int16Array([7, 7]).buffer))
      await sleep(300)
      assert.equal(connects(fakeLines.slice(afterIdle)), 0,
        'audio after idle cutoff must be dropped (no reconnect): ' + JSON.stringify(fakeLines.slice(afterIdle)))
      // explicit start resumes
      ws.send(JSON.stringify({ type: 'start' }))
      await sleep(400)
      assert.ok(connects(fakeLines.slice(afterIdle)) >= 1,
        'explicit start after idle must reconnect: ' + JSON.stringify(fakeLines.slice(afterIdle)))
    },
  })
  assert.ok(statuses.includes('idle'), 'client must be told status:idle on cutoff; got ' + JSON.stringify(statuses))
  assert.ok(fakeLines.includes('close'), 'idle cutoff must close the upstream socket; got ' + JSON.stringify(fakeLines))
  console.log('PASS B (idle): cutoff closes upstream + status:idle; audio dropped until explicit start reconnects.')
}

function loudFrame(samples = 256, amp = 8000) {
  const a = new Int16Array(samples); a.fill(amp); return Buffer.from(a.buffer)
}
function quietFrame(samples = 256, amp = 5) {
  const a = new Int16Array(samples); a.fill(amp); return Buffer.from(a.buffer)
}

// ── Test C: energy-gated resume after idle (speech reconnects, silence doesn't) ─
async function testResume() {
  const { fakeLines } = await runBridge({
    port: 8193, idleMs: 400, autoCloseMs: 0,
    fn: async ({ ws, fakeLines }) => {
      ws.send(JSON.stringify({ type: 'start' }))
      await sleep(150)
      await sleep(700)                              // idle cutoff fires (~400ms)
      const afterIdle = fakeLines.length
      ws.send(quietFrame()); ws.send(quietFrame())  // silence — must NOT reconnect
      await sleep(300)
      assert.equal(connects(fakeLines.slice(afterIdle)), 0,
        'silent frames after idle must not reconnect: ' + JSON.stringify(fakeLines.slice(afterIdle)))
      ws.send(loudFrame())                           // speech — must reconnect
      await sleep(400)
      assert.ok(connects(fakeLines.slice(afterIdle)) >= 1,
        'a loud (speech) frame after idle must reconnect: ' + JSON.stringify(fakeLines.slice(afterIdle)))
    },
  })
  console.log('PASS C (resume): silence stays closed; speech (RMS>threshold) reconnects upstream.')
}

// ── Test D: client-sent tunables (Preferences) override the bridge defaults ────
async function testClientParams() {
  // Bridge default idle is high (60s); the client's start message asks for 300ms.
  const { fakeLines, statuses } = await runBridge({
    port: 8194, idleMs: 60000, autoCloseMs: 0,
    fn: async ({ ws }) => {
      ws.send(JSON.stringify({ type: 'start', idleMs: 300, prerollMs: 200, resumeRms: 100 }))
      // The idle check runs on a 1s interval, so a 300ms idleMs fires at the first
      // tick (~1s). Wait past that. (With the 60s bridge default it would never fire.)
      await sleep(1600)
    },
  })
  assert.ok(statuses.includes('idle'),
    'client-sent idleMs:300 must drive the cutoff despite the 60s bridge default; statuses=' + JSON.stringify(statuses))
  assert.ok(fakeLines.includes('close'), 'idle cutoff (client param) must close upstream')
  console.log('PASS D (tunables): client start-message params override the bridge defaults.')
}

// ── Test E: Deepgram recognition params (endpointing/utterance_end_ms) reach DG ─
async function testDeepgramParams() {
  const { fakeLines } = await runBridge({
    port: 8195, idleMs: 60000, autoCloseMs: 0,
    fn: async ({ ws }) => {
      ws.send(JSON.stringify({ type: 'start', endpointing: 500, utterance_end_ms: 1500 }))
      await sleep(400)
    },
  })
  const connectLine = fakeLines.find(l => l.startsWith('listen.connect'))
  assert.ok(connectLine, 'should have connected; lines=' + JSON.stringify(fakeLines))
  assert.match(connectLine, /endpointing=500/, 'client endpointing must reach the Deepgram connect: ' + connectLine)
  assert.match(connectLine, /utterance_end_ms=1500/, 'client utterance_end_ms must reach the Deepgram connect: ' + connectLine)
  console.log('PASS E (DG params): endpointing/utterance_end_ms from Preferences reach the Deepgram connect.')
}

try {
  await testStorm()
  await testIdle()
  await testResume()
  await testClientParams()
  await testDeepgramParams()
  console.log('\nALL PASS: storm fix + idle cutoff + resume + client tunables + DG params.')
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err.message)
  process.exit(1)
}
