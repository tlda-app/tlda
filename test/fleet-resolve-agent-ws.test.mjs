import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const SERVER_SCRIPT = join(ROOT, 'server', 'unified-server.mjs')
const hasLocalTls = existsSync(join(homedir(), '.config', 'tlda', 'localhost+2.pem')) &&
  existsSync(join(homedir(), '.config', 'tlda', 'localhost+2-key.pem'))
if (hasLocalTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const proto = hasLocalTls ? 'wss' : 'ws'
const httpProto = hasLocalTls ? 'https' : 'http'

async function waitFor(predicate, { timeout = 10000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      // Expected during server startup: retry until health is reachable.
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error('Timed out waiting for condition')
}

async function connectFleet(port) {
  const ws = new WebSocket(`${proto}://127.0.0.1:${port}/ws/fleet`)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return ws
}

function fleetRpc(ws) {
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data))
    if (!msg.id || !pending.has(msg.id)) return
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  })
  return (type, body = {}) => new Promise(resolve => {
    const id = `resolve-agent-test-${++seq}`
    pending.set(id, msg => resolve(msg.result ?? msg))
    ws.send(JSON.stringify({ id, type, ...body }))
  })
}

test('fleet WS resolve-agent routes through authoritative fleetStore.findAgent', { timeout: 20000 }, async () => {
  const port = 15400 + Math.floor(Math.random() * 1000)
  const dataDir = mkdtempSync(join(tmpdir(), 'tlda-resolve-agent-data-'))
  const projectsDir = mkdtempSync(join(tmpdir(), 'tlda-resolve-agent-projects-'))
  const fleetDb = join(dataDir, 'fleet.db')
  const server = spawn(process.execPath, ['--import', 'tsx', SERVER_SCRIPT, '--i-am-tlda-cli'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PROJECTS_DIR: projectsDir,
      TLDA_FLEET_DB: fleetDb,
      TLDA_NO_AUTH: '1',
      TLDA_DEV_SERVER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let fleet
  try {
    await waitFor(() => fetch(`${httpProto}://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }).then(r => r.ok))
    fleet = await connectFleet(port)
    const sendFleet = fleetRpc(fleet)

    assert.equal((await sendFleet('register', {
      agent_id: 'fleet:resolve-target',
      name: 'resolve-target',
      cwd: '/tmp/resolve-target',
      labels: ['resolver-test'],
    }))?.ok, true)

    const byName = await sendFleet('resolve-agent', { agent: 'resolve-target' })
    assert.equal(byName.agent?.id, 'fleet:resolve-target')
    assert.equal(byName.agent?.friendly_name, 'resolve-target')
    assert.equal(byName.agent?.cwd, '/tmp/resolve-target')

    const byId = await sendFleet('resolve-agent', { agent: 'fleet:resolve-target' })
    assert.equal(byId.agent?.id, 'fleet:resolve-target')

    const missing = await sendFleet('resolve-agent', { agent: 'missing-resolve-target' })
    assert.equal(missing.agent, null)
  } finally {
    try { fleet?.close() } catch {
      // Best-effort cleanup: test outcome is already determined.
    }
    server.kill('SIGTERM')
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 3000) })
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(projectsDir, { recursive: true, force: true })
  }
})
