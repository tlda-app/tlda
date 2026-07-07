// Integration test for the spawn-collision → synthetic activity + respawn-coercion behavior.
// Boots the worktree server against a temp DB on a test port, attaches a MOCK
// daemon (so no real claude is launched), registers a live agent, then drives
// the real WS `spawn` path and asserts what reached the daemon + the store.
import { WebSocketServer } from 'ws'
import WebSocket from 'ws'
import { spawn } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = 5193
const DB = `/tmp/spawn-collision-test-${process.pid}.db`
const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
const proto = useTls ? 'https' : 'http'
const wsProto = useTls ? 'wss' : 'ws'
const wsOpts = useTls ? { rejectUnauthorized: false } : {}

const fail = (m) => { console.error('FAIL:', m); cleanup(1) }
let srv
function cleanup(code) {
  try { srv?.kill('SIGKILL') } catch {}
  try { rmSync(DB, { force: true }) } catch {}
  try { rmSync(`${DB}-wal`, { force: true }) } catch {}
  try { rmSync(`${DB}-shm`, { force: true }) } catch {}
  process.exit(code)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 1. Boot the worktree server.
srv = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TLDA_FLEET_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
srv.stdout.on('data', d => { serverLog += d })
srv.stderr.on('data', d => { serverLog += d })

// Wait for health.
async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${proto}://localhost:${PORT}/api/health`)
      if (r.ok) return true
    } catch {}
    await sleep(500)
  }
  return false
}

// Mock daemon: captures spawn RPCs and replies ok.
const capturedRpcs = []
function startMockDaemon() {
  return new Promise((resolve) => {
    const dws = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet-daemon`, wsOpts)
    dws.on('open', () => {
      dws.send(JSON.stringify({
        type: 'daemon-hello', machine_id: 'testbox-caller', boot_id: Date.now(),
        user: 'test', hostname: 'testbox', version: 'test',
      }))
      setTimeout(() => resolve(dws), 300)
    })
    dws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      if (msg.type === 'rpc') {
        capturedRpcs.push(msg)
        dws.send(JSON.stringify({ type: 'rpc-reply', id: msg.id, result: { ok: true, mock: true } }))
      }
    })
    dws.on('error', (e) => fail(`mock daemon WS error: ${e.message}`))
  })
}

// Fleet client: register an agent + send spawn messages.
function openFleet() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet`, wsOpts)
    ws.on('open', () => setTimeout(() => resolve(ws), 200))
    ws.on('error', (e) => fail(`fleet WS error: ${e.message}`))
  })
}

async function run() {
  if (!await waitHealth()) fail(`server never became healthy.\n${serverLog}`)
  await startMockDaemon()
  const ws = await openFleet()

  // Register a live agent named "collidertest".
  ws.send(JSON.stringify({
    type: 'register',
    agent_id: 'fleet:tester1',
    name: 'collidertest',
    machine_id: 'testbox-caller',
    metadata: { spawnPolicy: { permission: 'read', policy: 'cwd' } },
  }))
  await sleep(800)

  // --- Case A: spawn a colliding name (no respawn flag). Expect coerce → respawn:true.
  ws.send(JSON.stringify({ type: 'spawn', name: 'collidertest', model: 'sonnet' }))
  await sleep(1200)

  // --- Case B: spawn a brand-new name. Expect fresh (respawn falsy).
  ws.send(JSON.stringify({ type: 'spawn', name: 'totallynewname', model: 'sonnet', permission: 'full' }))
  await sleep(1200)

  const spawnRpcs = capturedRpcs.filter(r => r.op === 'spawn')
  const collide = spawnRpcs.find(r => r.name === 'fleet:tester1')
  const fresh = spawnRpcs.find(r => r.name === 'totallynewname')

  if (!collide) fail(`no spawn RPC for fleet:tester1 reached the daemon. RPCs: ${JSON.stringify(spawnRpcs)}`)
  if (collide.respawn !== true) fail(`collision spawn should coerce respawn=true, got ${collide.respawn}`)
  if (collide.spawnPolicy || collide.grantedPermission || collide.mode) {
    fail(`server must not send granted policy/mode/fence on collision wake: ${JSON.stringify(collide)}`)
  }
  if (collide.callerRung !== 'read') fail(`server should relay callerRung read, got ${collide.callerRung}`)
  console.log('PASS: collision spawn coerced to respawn=true using the resolved fleet id')

  if (!fresh) fail(`no spawn RPC for totallynewname reached the daemon. RPCs: ${JSON.stringify(spawnRpcs)}`)
  if (fresh.respawn === true) fail(`new-name spawn should stay fresh (respawn falsy), got ${fresh.respawn}`)
  if (fresh.requestedPermission !== 'full') fail(`server should relay requestedPermission full, got ${fresh.requestedPermission}`)
  if (fresh.callerRung !== 'read') fail(`server should relay callerRung read, got ${fresh.callerRung}`)
  if (fresh.spawnPolicy || fresh.grantedPermission || fresh.mode) {
    fail(`server readiness/policy handling must be status-only; it must not choose grant/mode/fence: ${JSON.stringify(fresh)}`)
  }
  console.log('PASS: new-name spawn stayed fresh (respawn falsy)')
  console.log('PASS: server spawn path is relay-only for permission/fence/mode')

  // Assert the synthetic activity: a fresh 'activity' event for fleet:tester1 and
  // a bumped last_active. Read it back over the events API.
  const evRes = await fetch(`${proto}://localhost:${PORT}/api/store/events?agent=fleet:tester1&limit=50`)
  const evJson = await evRes.json()
  const events = evJson.events || evJson || []
  const activity = events.filter(e => (e.type === 'activity') && (e.from_id === 'fleet:tester1' || e.from === 'fleet:tester1'))
  const synthetic = activity.find(e => {
    let m = e.metadata
    if (typeof m === 'string') { try { m = JSON.parse(m) } catch { m = {} } }
    return m && m.synthetic === true
  })
  if (!synthetic) fail(`no synthetic activity (raise) event for fleet:tester1. activity events: ${JSON.stringify(activity)}`)
  console.log('PASS: synthetic activity event written for the existing agent')

  const itemRes = await fetch(`${proto}://localhost:${PORT}/api/items?userId=fleet:${process.env.TLDA_USER || process.env.USER}`)
  const itemJson = await itemRes.json()
  const bounce = (itemJson.items || []).find(i => String(i.id || '').startsWith('spawn-bounce:'))
  if (bounce) fail(`spawn-bounce item should be emitted by the librarian path, not notif-phase1: ${JSON.stringify(bounce)}`)
  console.log('PASS: notif-phase1 does not emit spawn-bounce items')

  // Assert last_active actually advanced past registration — this is the value
  // the panel's Active sort keys on, so this is what makes the agent rise.
  const stRes = await fetch(`${proto}://localhost:${PORT}/api/state`)
  const st = await stRes.json()
  const agent = (st.agents || []).find(a => a.id === 'fleet:tester1')
  if (!agent) fail('fleet:tester1 missing from /api/state')
  if (!agent.last_active) fail(`fleet:tester1 has no last_active: ${JSON.stringify(agent)}`)
  if (new Date(agent.last_active).getTime() < new Date(synthetic.timestamp).getTime()) {
    fail(`last_active (${agent.last_active}) did not advance to the raise event (${synthetic.timestamp})`)
  }
  console.log('PASS: last_active advanced to the raise event (agent floats to top of Active sort)')

  console.log('\nALL CHECKS PASSED')
  cleanup(0)
}

run().catch(e => fail(`exception: ${e.stack}`))
setTimeout(() => fail('overall test timeout'), 60000)
