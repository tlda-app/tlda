#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { WebSocket } from 'ws'
import Database from 'better-sqlite3'

import { createMachineRpc, rpcRequestFingerprint } from '../daemon/machine-rpc.mjs'

const PORT = Number(process.env.PORT || (5607 + (process.pid % 1000)))
const DB = `/tmp/spawn-mailbox-outcome-${process.pid}.db`
const CONFIG_DIR = `/tmp/spawn-mailbox-outcome-config-${process.pid}`
const ENV_NAME = 'default'
const MACHINE_ID = 'spawn-outcome-box'
const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
if (useTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const proto = useTls ? 'https' : 'http'
const wsProto = useTls ? 'wss' : 'ws'
const wsOpts = useTls ? { rejectUnauthorized: false } : {}

let srv
let serverLog = ''
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function cleanup(code) {
  try { srv?.kill('SIGKILL') } catch (e) {
    if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup server kill failed: ${e.message}`)
  }
  for (const path of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { rmSync(path, { force: true }) } catch (e) {
      if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup db path failed for ${path}: ${e.message}`)
    }
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

async function waitHealth() {
  let lastError = null
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${proto}://localhost:${PORT}/api/health`)
      if (r.ok) return
    } catch (e) {
      lastError = e
    }
    await sleep(250)
  }
  fail(`server never became healthy${lastError ? `: ${lastError.message}` : ''}\nSERVER LOG:\n${serverLog}`)
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

async function reserveAndLogin(ws, agentId, name) {
  await request(ws, 'reserve-shell', {
    agent_id: agentId,
    name,
    machine_id: MACHINE_ID,
    env_name: ENV_NAME,
    daemon_key: `${MACHINE_ID}:${ENV_NAME}`,
    metadata: { permissionGrant: 'ops' },
  })
  return request(ws, 'login', { agent_id: agentId, kind: 'codex' })
}

async function waitForAgent(agentId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stateRes = await fetch(`${proto}://localhost:${PORT}/api/state`)
    const state = await stateRes.json()
    const agent = (state.agents || []).find(a => a.id === agentId)
    if (agent && agent.metadata?.shell !== true) return agent
    await sleep(100)
  }
  return null
}

async function waitForChat(ws, pattern, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = await request(ws, 'store-events', {
      agent: 'fleet:spawn-outcome-requester',
      event_types: ['chat'],
      limit: 50,
    })
    const found = (events.events || []).find(e => pattern.test(e.text || ''))
    if (found) return found
    await sleep(100)
  }
  return null
}

async function startMockDaemon() {
  const daemon = new WebSocket(`${wsProto}://localhost:${PORT}/ws/fleet-daemon`, wsOpts)
  const modes = []
  const captured = []
  const executionDbPath = `/tmp/spawn-mailbox-outcome-rpc-${process.pid}.sqlite`
  const executionDb = new Database(executionDbPath)
  executionDb.exec(`
    CREATE TABLE IF NOT EXISTS daemon_rpc_executions (
      request_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'terminal')),
      reply TEXT,
      updated_at INTEGER NOT NULL
    )
  `)
  const rpc = createMachineRpc({
    sendMsg: message => {
      try { daemon.send(JSON.stringify(message)) } catch (e) {
        if (process.env.TLDA_TEST_DEBUG) console.error(`mock daemon send failed: ${e.message}`)
      }
    },
    executionDbPath,
  })
  rpc.register({
    mint: async msg => ({ ok: true, pending: true, agent_id: msg.agent_id, fleetId: msg.agent_id }),
    spawn: async msg => ({ ok: true, pending: true, agent_id: msg.agent_id, fleetId: msg.agent_id }),
    wake: async msg => ({ ok: true, pending: true, agent_id: msg.agent_id, fleetId: msg.agent_id }),
  })
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
  daemon.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.type !== 'rpc' || !['mint', 'spawn', 'wake'].includes(msg.op)) return
    captured.push(msg)
    const mode = modes.shift() || 'ok'
    if (mode === 'indeterminate') {
      executionDb.prepare(`
        INSERT OR REPLACE INTO daemon_rpc_executions
          (request_id, operation, fingerprint, status, reply, updated_at)
        VALUES (?, ?, ?, 'running', NULL, ?)
      `).run(msg.id, msg.op, rpcRequestFingerprint(msg), Date.now())
      void rpc.handleRpc(msg)
      return
    }
    if (mode === 'failure') {
      daemon.send(JSON.stringify({
        type: 'rpc-reply',
        id: msg.id,
        result: { ok: false, reason: 'test-failed', error: 'daemon refused launch for test' },
      }))
      return
    }
    void rpc.handleRpc(msg)
  })
  daemon.on('close', () => {
    try { executionDb.close() } catch (e) {
      if (process.env.TLDA_TEST_DEBUG) console.error(`mock daemon rpc db close failed: ${e.message}`)
    }
    for (const path of [executionDbPath, `${executionDbPath}-wal`, `${executionDbPath}-shm`]) {
      try { rmSync(path, { force: true }) } catch (e) {
        if (process.env.TLDA_TEST_DEBUG) console.error(`mock daemon rpc db cleanup failed for ${path}: ${e.message}`)
      }
    }
  })
  return { daemon, modes, captured }
}

async function run() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const base = `${proto}://localhost:${PORT}`
  writeFileSync(`${CONFIG_DIR}/server.yaml`, '')
  writeFileSync(`${CONFIG_DIR}/daemon.yaml`, `machineId: ${MACHINE_ID}\ndefaultEnv: test\nenvironments:\n  test:\n    database: ${base}\n    store: ${base}\n    licenseKey: ""\nregions:\n  machine: ["**"]\nprofiles:\n  ops:\n    read: { allow: [machine], deny: [] }\n    write: { allow: [machine], deny: [] }\ngrants:\n  localhost: ops\nmodels: {}\ndefault: ops\n`)
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
      TLDA_SPAWN_LOGIN_DEADLINE_MS: '1200',
      TLDA_SPAWN_MAILBOX_DEADLINE_MS: '2500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', d => { serverLog += d })
  srv.stderr.on('data', d => { serverLog += d })

  await waitHealth()
  const { daemon, modes } = await startMockDaemon()
  const requesterWs = await openFleet()
  const spawnedWs = await openFleet()
  try {
    await reserveAndLogin(requesterWs, 'fleet:spawn-outcome-requester', 'spawn-outcome-requester')

    modes.push('indeterminate')
    const unknownStarted = await request(requesterWs, 'spawn', {
      fresh: true,
      name: 'unknown-started',
      model: 'sol',
      cwd: process.cwd(),
      iLikeToLiveDangerously: true,
    })
    assert.equal(unknownStarted.ok, true)
    assert.ok(unknownStarted.agent_id)
    await request(spawnedWs, 'login', { agent_id: unknownStarted.agent_id, kind: 'codex' })
    const live = await waitForAgent(unknownStarted.agent_id)
    assert.ok(live, `indeterminate fresh spawn did not resolve to live login; server log:\n${serverLog}`)
    const wrongFailure = await waitForChat(requesterWs, /Mint mailbox .* failed.*unknown-started/, 500)
    assert.equal(wrongFailure, null)
    console.log('PASS: indeterminate fresh spawn resolves by observing login, not by reporting failure')

    modes.push('failure')
    await request(requesterWs, 'spawn', {
      fresh: true,
      name: 'known-failed',
      model: 'sol',
      cwd: process.cwd(),
      iLikeToLiveDangerously: true,
    })
    const failed = await waitForChat(requesterWs, /Mint mailbox .* failed.*known-failed.*daemon refused launch for test/)
    assert.ok(failed, `real spawn failure was not reported as failed; server log:\n${serverLog}`)
    console.log('PASS: daemon-declared spawn failure still reports failed')

    modes.push('indeterminate')
    await request(requesterWs, 'spawn', {
      agent: 'fleet:spawn-outcome-requester',
      respawn: true,
      iLikeToLiveDangerously: true,
    })
    const indeterminate = await waitForChat(requesterWs, /Mint mailbox .* indeterminate.*spawn-outcome-requester/)
    assert.ok(indeterminate, `unresolved wake outcome was not reported as indeterminate; server log:\n${serverLog}`)
    assert.doesNotMatch(indeterminate.text, / failed/)
    console.log('PASS: unresolved respawn outcome reports indeterminate, not failed')
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
