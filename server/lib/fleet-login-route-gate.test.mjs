import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error.message || message.error))
      else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

async function openFleetWs(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function startServer(dir, dbPath, port) {
  return spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('agent login requires daemon route proof before clearing a shell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-login-route-gate-'))
  const dbPath = join(dir, 'fleet.db')
  const now = new Date().toISOString()
  let store = new FleetStore(dbPath, { taskDoc: false })
  await store.upsertAgent({
    id: 'fleet:recipient',
    friendly_name: 'recipient',
    labels: [],
    registered_at: now,
    last_seen: now,
    metadata: { shell: true },
  })
  store.close()

  const port = await unusedPort()
  const child = startServer(dir, dbPath, port)
  let ws
  try {
    await waitForServer(child)
    ws = await openFleetWs(port)

    await assert.rejects(
      request(ws, 1, 'login', { agent_id: 'fleet:recipient' }),
      /requires daemon route information/
    )
  } finally {
    ws?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }

  try {
    store = new FleetStore(dbPath, { taskDoc: false })
    const shell = await store.getAgent('fleet:recipient')
    assert.equal(shell.metadata.shell, true)
    assert.equal(store.getAgentDaemonRoute('fleet:recipient'), null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent login writes the daemon route projection from the login proof', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-login-route-proof-'))
  const dbPath = join(dir, 'fleet.db')
  const now = new Date().toISOString()
  let store = new FleetStore(dbPath, { taskDoc: false })
  await store.upsertAgent({
    id: 'fleet:recipient',
    friendly_name: 'recipient',
    labels: [],
    registered_at: now,
    last_seen: now,
    metadata: { shell: true },
  })
  store.close()

  const port = await unusedPort()
  const child = startServer(dir, dbPath, port)
  let ws
  try {
    await waitForServer(child)
    ws = await openFleetWs(port)

    const result = await request(ws, 1, 'login', {
      agent_id: 'fleet:recipient',
      machine_id: 'mini',
      env_name: 'testing',
      metadata: { kind: 'codex' },
    })

    assert.equal(result.ok, true)
    assert.equal(result.agent.id, 'fleet:recipient')
    assert.equal(result.agent.daemon_key, 'mini:testing')
    assert.equal(result.agent.machine_id, 'mini')
    assert.equal(result.agent.env_name, 'testing')
    assert.equal(result.agent.metadata.shell, undefined)
  } finally {
    ws?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }

  try {
    store = new FleetStore(dbPath, { taskDoc: false })
    assert.deepEqual(store.getAgentDaemonRoute('fleet:recipient'), {
      agent_id: 'fleet:recipient',
      daemon_key: 'mini:testing',
    })
    assert.equal((await store.getAgent('fleet:recipient')).metadata.shell, undefined)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
