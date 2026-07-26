#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'

const PORT = Number(process.env.PORT || (5207 + (process.pid % 1000)))
const DB = `/tmp/delegate-spawn-shell-e2e-${process.pid}.db`
const CONFIG_DIR = `/tmp/delegate-spawn-shell-e2e-config-${process.pid}`
const ENV_NAME = 'default'
const MACHINE_ID = 'delegate-e2e-box'
const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
if (useTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const proto = useTls ? 'https' : 'http'
const wsProto = useTls ? 'wss' : 'ws'
const wsOpts = useTls ? { rejectUnauthorized: false } : {}

let srv
let serverLog = ''
function cleanup(code) {
  try { srv?.kill('SIGKILL') } catch (e) { // best-effort test cleanup
    if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup server kill failed: ${e.message}`)
  }
  try { rmSync(DB, { force: true }) } catch (e) { // best-effort test cleanup
    if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup db failed: ${e.message}`)
  }
  try { rmSync(`${DB}-wal`, { force: true }) } catch (e) { // best-effort test cleanup
    if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup db wal failed: ${e.message}`)
  }
  try { rmSync(`${DB}-shm`, { force: true }) } catch (e) { // best-effort test cleanup
    if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup db shm failed: ${e.message}`)
  }
  try { rmSync(CONFIG_DIR, { recursive: true, force: true }) } catch (e) {
    if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup config dir failed: ${e.message}`)
  }
  process.exit(code)
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  cleanup(1)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(50)
  }
  return null
}

async function waitHealth() {
  let lastError = null
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${proto}://localhost:${PORT}/api/health`)
      if (r.ok) return
    } catch (e) {
      lastError = e
    }
    await sleep(500)
  }
  fail(`server never became healthy${lastError ? `: ${lastError.message}` : ''}\nSERVER LOG:\n${serverLog}`)
}

async function waitForAgent(agentId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stateRes = await fetch(`${proto}://localhost:${PORT}/api/state`)
    const state = await stateRes.json()
    const agent = (state.agents || []).find(a => a.id === agentId)
    if (agent) return agent
    await sleep(100)
  }
  return null
}

function openFleet() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet`, wsOpts)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function request(ws, type, body = {}, timeoutMs = 5000) {
  const id = `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`${type} request timed out`))
    }, timeoutMs)
    const onMessage = raw => {
      const msg = JSON.parse(raw.toString())
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      if (msg.error) reject(new Error(msg.error.message || String(msg.error)))
      else resolve(msg.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...body }))
  })
}

async function reserveShell(agentId, name) {
  const ws = await openFleet()
  try {
    return await request(ws, 'reserve-shell', {
      agent_id: agentId,
      local_agent_id: `local-${agentId.split(':').pop()}`,
      name,
      tmux_session: `fleet-${name}`,
      cwd: process.cwd(),
      model: 'sol',
      kind: 'codex',
      machine_id: MACHINE_ID,
      env_name: ENV_NAME,
      daemon_key: `${MACHINE_ID}:${ENV_NAME}`,
      metadata: { permissionGrant: 'ops' },
    })
  } finally {
    ws.close()
  }
}

async function startMockDaemon() {
  const daemon = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet-daemon`, wsOpts)
  const captured = []
  await new Promise((resolve, reject) => {
    daemon.on('open', () => {
      daemon.send(JSON.stringify({
        type: 'daemon-hello',
        machine_id: MACHINE_ID,
        env_name: ENV_NAME,
        boot_id: Date.now(),
        user: 'test',
        hostname: MACHINE_ID,
        version: 'test',
      }))
      setTimeout(resolve, 250)
    })
    daemon.on('error', reject)
  })
  daemon.on('message', async raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.type !== 'rpc' || !['spawn', 'mint'].includes(msg.op)) return
    captured.push(msg)
    try {
      assert.ok(msg.agent_id, `spawn RPC missing agent_id: ${JSON.stringify(msg)}`)
      await reserveShell(msg.agent_id, msg.friendly_name || msg.name || 'delegate-e2e-spawned')
      daemon.send(JSON.stringify({
        type: 'rpc-reply',
        id: msg.id,
        result: {
          ok: true,
          pending: true,
          agent_id: msg.agent_id,
          fleetId: msg.agent_id,
          tmuxSession: `fleet-${msg.friendly_name || msg.name || 'delegate-e2e-spawned'}`,
          harness: 'codex',
          model: msg.model || 'sol',
        },
      }))
    } catch (e) {
      daemon.send(JSON.stringify({ type: 'rpc-reply', id: msg.id, result: { ok: false, error: e.message, reason: 'test-failed' } }))
    }
  })
  return { daemon, captured }
}

async function run() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const base = `${proto}://localhost:${PORT}`
  writeFileSync(`${CONFIG_DIR}/server.yaml`, '')
  writeFileSync(`${CONFIG_DIR}/daemon.yaml`, `machineId: ${MACHINE_ID}\nenvironments:\n  default: test\n  values:\n    test:\n      database: ${base}\n      store: ${base}\n      licenseKey: \"\"\nregions:\n  machine: [\"**\"]\nprofiles:\n  ops:\n    read: { allow: [machine], deny: [] }\n    write: { allow: [machine], deny: [] }\ngrants:\n  localhost: ops\nmodels: {}\ndefault: ops\n`)
  srv = spawnProcess('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      TLDA_FLEET_DB: DB,
      TLDA_CONFIG_DIR: CONFIG_DIR,
      TLDA_DAEMON_CONFIG_DIR: CONFIG_DIR,
      TLDA_ENV: 'test',
      TLDA_DEV_SERVER: '1',
      TLDA_SPAWN_MAILBOX_DEADLINE_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', d => { serverLog += d })
  srv.stderr.on('data', d => { serverLog += d })

  await waitHealth()
  const { daemon, captured } = await startMockDaemon()
  const requesterWs = await openFleet()
  const spawnedWs = await openFleet()
  try {
    await request(requesterWs, 'reserve-shell', {
      agent_id: 'fleet:delegate-e2e-requester',
      name: 'delegate-e2e-requester',
      machine_id: MACHINE_ID,
      env_name: ENV_NAME,
      daemon_key: `${MACHINE_ID}:${ENV_NAME}`,
      metadata: { permissionGrant: 'ops' },
    })
    await request(requesterWs, 'login', { agent_id: 'fleet:delegate-e2e-requester' })

    const spawnResult = await request(requesterWs, 'spawn', {
      fresh: true,
      name: 'delegate-e2e-spawned',
      model: 'sol',
      cwd: process.cwd(),
      mailboxTarget: 'fleet:delegate-e2e-requester',
      iLikeToLiveDangerously: true,
    })
    assert.equal(spawnResult.ok, true)
    assert.ok(spawnResult.agent_id, `spawn result missing agent_id: ${JSON.stringify(spawnResult)}`)
    await waitFor(() => captured.length === 1)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].agent_id, spawnResult.agent_id)
    console.log('PASS: delegate fresh spawn RPC carried a preallocated fleet agent_id')

    const shell = await waitForAgent(spawnResult.agent_id)
    assert.ok(shell, `reserved shell row did not appear for ${spawnResult.agent_id}; server log:\n${serverLog}`)
    assert.equal(shell.metadata?.shell, true)
    const loginResult = await request(spawnedWs, 'login', { agent_id: spawnResult.agent_id, kind: 'codex' })
    assert.equal(loginResult.ok, true)
    assert.equal(loginResult.agent.id, spawnResult.agent_id)
    assert.notEqual(loginResult.agent.metadata?.shell, true)
    console.log('PASS: spawned process can login against the reserved shell row')

    const delegateResult = await request(requesterWs, 'delegate', {
      from: 'fleet:delegate-e2e-requester',
      agent: spawnResult.agent_id,
      description: 'E2E delegate spawn shell ownership proof',
      message: 'Own this E2E proof task.',
      operation_id: `delegate-e2e:${process.pid}`,
    })
    assert.equal(delegateResult.ok, true)
    assert.ok(delegateResult.task_id)

    const inbox = await request(spawnedWs, 'my-task', { agent: spawnResult.agent_id })
    assert.equal(inbox.task.id, delegateResult.task_id)
    assert.equal(inbox.task.agent, spawnResult.agent_id)
    assert.ok((inbox.messages || []).some(m => m.type === 'delegate' || m.task_id === delegateResult.task_id))
    console.log('PASS: spawned shell owns a durable task visible through my-task/inbox')

    const chatResult = await request(spawnedWs, 'chat', {
      from: spawnResult.agent_id,
      to: 'fleet:delegate-e2e-requester',
      message: 'E2E direct response from spawned shell.',
    })
    assert.equal(chatResult.ok, true)

    const events = await request(requesterWs, 'store-events', {
      agent: 'fleet:delegate-e2e-requester',
      event_types: ['chat'],
      limit: 20,
    })
    assert.ok((events.events || []).some(e => e.from === spawnResult.agent_id && e.text === 'E2E direct response from spawned shell.'))
    console.log('PASS: spawned shell direct chat response is stored under its fleet id')

    const stateRes = await fetch(`${proto}://localhost:${PORT}/api/state`)
    const state = await stateRes.json()
    const agent = (state.agents || []).find(a => a.id === spawnResult.agent_id)
    assert.ok(agent, `spawned agent missing from state; server log:\n${serverLog}`)
    assert.equal(agent.dead, false)
    console.log('PASS: roster state includes the spawned live shell')
  } finally {
    requesterWs.close()
    spawnedWs.close()
    daemon.close()
  }
}

run().then(() => {
  console.log('ALL CHECKS PASSED')
  cleanup(0)
}).catch(e => fail(`${e.stack}\nSERVER LOG:\n${serverLog || ''}`))

setTimeout(() => fail('overall test timeout'), 45_000)
