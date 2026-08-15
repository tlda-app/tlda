import assert from 'node:assert/strict'
import https from 'node:https'
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

function startServer({ dir, dbPath, port }) {
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
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
  return child
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

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
}

function postJson(port, path, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch (error) {
          reject(error)
          return
        }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function openDaemon(port, { onRpc = null } = {}) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet-daemon`, { rejectUnauthorized: false })
  const messages = []
  ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    messages.push(message)
    if (message.type !== 'rpc' || !onRpc) return
    void Promise.resolve().then(() => onRpc(message)).then(
      result => ws.send(JSON.stringify({ type: 'rpc-reply', id: message.id, result })),
      error => ws.send(JSON.stringify({ type: 'rpc-reply', id: message.id, error: error?.message || String(error) })),
    )
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const welcome = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`daemon welcome timed out: ${JSON.stringify(messages)}`)), 20_000)
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.type !== 'daemon-welcome') return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify({
    type: 'daemon-hello',
    machine_id: 'mini',
    env_name: 'testing',
    boot_id: Date.now(),
    install_path: import.meta.dirname,
    hostname: 'mini.local',
    version: 'test',
  }))
  await welcome
  return { ws, messages }
}

async function seedDeadAgent(dbPath, { route = false } = {}) {
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  try {
    await store.upsertAgent({
      id: 'fleet:reanimate-wire',
      friendly_name: 'reanimate-wire',
      labels: [],
      registered_at: now,
      last_seen: now,
      dead: true,
      metadata: { kind: 'codex' },
    })
    if (route) store.setAgentDaemonRoute('fleet:reanimate-wire', 'mini:testing')
  } finally {
    store.close()
  }
}

test('reanimate succeeds over the current agent_daemon_routes owner wire', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-reanimate-route-success-'))
  const dbPath = join(dir, 'fleet.db')
  await seedDeadAgent(dbPath, { route: true })
  const port = await unusedPort()
  const child = startServer({ dir, dbPath, port })
  let daemon = null
  const wakeCalls = []
  try {
    await waitForServer(child)
    daemon = await openDaemon(port, {
      onRpc: message => {
        wakeCalls.push({ op: message.op, fleet_id: message.fleet_id })
        assert.equal(message.op, 'wake')
        assert.equal(message.fleet_id, 'fleet:reanimate-wire')
        return { ok: true, resumed: true }
      },
    })

    const response = await postJson(port, '/api/agents/fleet%3Areanimate-wire/reanimate')

    assert.equal(response.status, 200, response.text)
    assert.equal(response.json.ok, true)
    assert.deepEqual(wakeCalls, [{ op: 'wake', fleet_id: 'fleet:reanimate-wire' }])
  } finally {
    daemon?.ws?.close()
    await stopServer(child)
    const store = new FleetStore(dbPath, { taskDoc: false })
    try {
      const agent = await store.getAgent('fleet:reanimate-wire')
      assert.equal(agent.dead, false)
      assert.deepEqual(store.getAgentDaemonRoute('fleet:reanimate-wire'), {
        agent_id: 'fleet:reanimate-wire',
        daemon_key: 'mini:testing',
      })
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('reanimate refuses a dead agent without a current daemon route even when that daemon is connected', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-reanimate-missing-route-'))
  const dbPath = join(dir, 'fleet.db')
  await seedDeadAgent(dbPath, { route: false })
  const port = await unusedPort()
  const child = startServer({ dir, dbPath, port })
  let daemon = null
  const wakeCalls = []
  try {
    await waitForServer(child)
    daemon = await openDaemon(port, {
      onRpc: message => {
        wakeCalls.push(message)
        return { ok: true }
      },
    })

    const response = await postJson(port, '/api/agents/fleet%3Areanimate-wire/reanimate')

    assert.equal(response.status, 409, response.text)
    assert.match(response.json.error, /has no daemon route on the server/)
    assert.deepEqual(wakeCalls, [])
  } finally {
    daemon?.ws?.close()
    await stopServer(child)
    const store = new FleetStore(dbPath, { taskDoc: false })
    try {
      const agent = await store.getAgent('fleet:reanimate-wire')
      assert.equal(agent.dead, true)
      assert.equal(store.getAgentDaemonRoute('fleet:reanimate-wire'), null)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
