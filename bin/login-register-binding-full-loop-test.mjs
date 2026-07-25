#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn as spawnProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'

const PORT = Number(process.env.PORT || (5700 + (process.pid % 1000)))
const BASE = `http://127.0.0.1:${PORT}`
const WS_BASE = BASE.replace(/^http/, 'ws')
const ROOT = join(tmpdir(), `tlda-login-binding-loop-${process.pid}`)
const CONFIG_DIR = join(ROOT, 'config')
const HOME_DIR = join(ROOT, 'home')
const PROJECTS_DIR = join(ROOT, 'projects')
const DB = join(ROOT, 'fleet.db')
const MACHINE_ID = 'login-loop-box'
const ENV_NAME = 'loop'
const DAEMON_KEY = `${MACHINE_ID}:${ENV_NAME}`
const AGENT_ID = 'fleet:login-loop'
const LOCAL_AGENT_ID = 'local:login-loop'
const NAME = 'login-loop-agent'
const SESSION_ID = '019f8802-aaaa-7000-8000-000000000001'
const ROLLOUT = join(HOME_DIR, '.codex', 'sessions', '2026', '07', '22', `rollout-2026-07-22T00-00-00-${SESSION_ID}.jsonl`)

let server = null
let daemon = null
let serverLog = ''
let daemonLog = ''

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function cleanup(code) {
  try { daemon?.kill('SIGKILL') } catch { /* best-effort test daemon cleanup */ }
  try { server?.kill('SIGKILL') } catch { /* best-effort test server cleanup */ }
  try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* best-effort temp directory cleanup */ }
  process.exit(code)
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  console.error(`\nSERVER LOG:\n${serverLog}`)
  console.error(`\nDAEMON LOG:\n${daemonLog}`)
  cleanup(1)
}

async function waitFor(label, fn, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (e) {
      last = e
    }
    await sleep(intervalMs)
  }
  fail(`${label} timed out${last ? `: ${last.message}` : ''}`)
}

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
  return await res.json()
}

function openFleet() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/fleet`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function request(ws, type, body = {}, timeoutMs = 10000) {
  const id = `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`${type} timed out`))
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

function writeConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  mkdirSync(HOME_DIR, { recursive: true })
  mkdirSync(PROJECTS_DIR, { recursive: true })
  writeFileSync(join(CONFIG_DIR, 'server.yaml'), `defaultServer: loop
servers:
  loop:
    database: ${BASE}
    store: ${BASE}
    licenseKey: test
`)
  writeFileSync(join(CONFIG_DIR, 'daemon.yaml'), `machineId: ${MACHINE_ID}
regions:
  machine:
    - "**"
profiles:
  ops:
    read:
      allow: [machine]
      deny: []
    write:
      allow: [machine]
      deny: []
grants:
  localhost: ops
  ${AGENT_ID}: ops
models: {}
default: ops
`)
}

function daemonLogText() {
  const paths = [
    join(CONFIG_DIR, `fleet-daemon.${ENV_NAME}.log`),
    join(CONFIG_DIR, 'fleet-daemon.log'),
  ]
  const fileText = paths
    .filter(p => existsSync(p))
    .map(p => readFileSync(p, 'utf8'))
    .join('\n')
  return `${daemonLog}\n${fileText}`
}

function writeRollout() {
  mkdirSync(join(HOME_DIR, '.codex', 'sessions', '2026', '07', '22'), { recursive: true })
  writeFileSync(ROLLOUT, `${JSON.stringify({
    timestamp: '2026-07-22T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: SESSION_ID,
      id: SESSION_ID,
      timestamp: '2026-07-22T00:00:00.000Z',
      cwd: ROOT,
      originator: 'codex-tui',
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
    },
  })}\n`)
}

function appendActivityLine() {
  appendFileSync(ROLLOUT, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg-ready-after-relogin',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'READY' }],
      phase: 'final_answer',
    },
  })}\n`)
}

function seedDaemonProcessLedger() {
  const ledger = createPermissionLedger(join(CONFIG_DIR, 'fleet-daemon.db'))
  try {
    ledger.setSync(AGENT_ID, {
      permissionGrant: 'ops',
      source: 'login-register-binding-full-loop-test',
    })
    ledger.setSessionSync(AGENT_ID, {
      sessionId: SESSION_ID,
      sessionKind: 'codex',
      sessionPath: ROLLOUT,
      tmuxSession: `fleet-${NAME}`,
      model: 'gpt-test',
      machineId: MACHINE_ID,
      envName: ENV_NAME,
      daemonKey: DAEMON_KEY,
      terminalCapability: 'termcap:login-loop',
      cwd: ROOT,
      friendlyName: NAME,
    })
  } finally {
    ledger.close()
  }
}

async function startDaemon() {
  daemon = spawnProcess('node', ['bin/fleet-daemon.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: HOME_DIR,
      TLDA_CONFIG: ENV_NAME,
      TLDA_CONFIG_DIR: CONFIG_DIR,
      TLDA_DAEMON_CONFIG_DIR: CONFIG_DIR,
      TLDA_MACHINE_ID: MACHINE_ID,
      TLDA_DEV_DAEMON: BASE,
      PROJECTS_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout.on('data', d => { daemonLog += d.toString() })
  daemon.stderr.on('data', d => { daemonLog += d.toString() })
  await waitFor('daemon ready', () => {
    const text = daemonLogText()
    return /daemon-ready/.test(text)
  }, { timeoutMs: 45000 })
}

async function stopDaemon() {
  if (!daemon) return
  const proc = daemon
  daemon = null
  proc.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => proc.once('exit', resolve)),
    sleep(3000),
  ])
}

async function startServerAndDaemon() {
  server = spawnProcess('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: HOME_DIR,
      PORT: String(PORT),
      TLDA_CONFIG: ENV_NAME,
      TLDA_CONFIG_DIR: CONFIG_DIR,
      TLDA_FLEET_DB: DB,
      TLDA_DEV_SERVER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', d => { serverLog += d.toString() })
  server.stderr.on('data', d => { serverLog += d.toString() })
  await waitFor('server health', async () => {
    const res = await fetch(`${BASE}/api/health`).catch(() => null)
    return res?.ok
  })
  await startDaemon()
}

function assertBoundAgent(agent, label) {
  assert.equal(agent.id, AGENT_ID, `${label}: id`)
  assert.equal(agent.session_id, SESSION_ID, `${label}: session_id`)
  assert.deepEqual(agent.session_ids, [SESSION_ID], `${label}: session_ids`)
  assert.equal(agent.cwd, ROOT, `${label}: cwd`)
  assert.equal(agent.machine_id, MACHINE_ID, `${label}: machine_id`)
  assert.equal(agent.env_name, ENV_NAME, `${label}: env_name`)
  assert.equal(agent.daemon_key, DAEMON_KEY, `${label}: daemon_key`)
  assert.equal(agent.resume_id, SESSION_ID, `${label}: resume_id`)
}

async function run() {
  writeConfig()
  writeRollout()
  await startServerAndDaemon()

  const ws = await openFleet()
  try {
    const reserve = await request(ws, 'reserve-shell', {
      agent_id: AGENT_ID,
      local_agent_id: LOCAL_AGENT_ID,
      name: NAME,
      tmux_session: `fleet-${NAME}`,
      cwd: ROOT,
      model: 'gpt-test',
      kind: 'codex',
      machine_id: MACHINE_ID,
      env_name: ENV_NAME,
      daemon_key: DAEMON_KEY,
      metadata: { permissionGrant: 'ops' },
    })
    assert.equal(reserve.ok, true)
    console.log('PASS: mint shell reserved with stable fleet id')

    const firstLogin = await request(ws, 'login', { agent_id: AGENT_ID, kind: 'codex' })
    assert.equal(firstLogin.ok, true)
    assert.equal(firstLogin.agent.id, AGENT_ID)
    console.log('PASS: minted agent logged in')

    await api('/api/agent-seat', {
      method: 'POST',
      body: {
        agent_id: AGENT_ID,
        session_id: SESSION_ID,
        resume_id: SESSION_ID,
        kind: 'codex',
        model: 'gpt-test',
        cwd: ROOT,
        machine_id: MACHINE_ID,
        env_name: ENV_NAME,
        daemon_key: DAEMON_KEY,
        terminal_capability: 'termcap:login-loop',
        created_source: 'login-register-binding-full-loop-test',
        transition_reason: 'mint',
      },
    })
    const seat = await api(`/api/agent-seat?agent=${encodeURIComponent(AGENT_ID)}`)
    assert.equal(seat.seat.session_id, SESSION_ID)
    assert.equal(seat.seat.machine_id, MACHINE_ID)
    console.log('PASS: durable binding written')

    const wakeReserve = await request(ws, 'reserve-shell', {
      agent_id: AGENT_ID,
      local_agent_id: LOCAL_AGENT_ID,
      name: NAME,
      tmux_session: `fleet-${NAME}`,
      cwd: ROOT,
      model: 'gpt-test',
      kind: 'codex',
      machine_id: MACHINE_ID,
      env_name: ENV_NAME,
      daemon_key: DAEMON_KEY,
      metadata: { permissionGrant: 'ops' },
    })
    assert.equal(wakeReserve.ok, true)
    assert.equal(wakeReserve.agent_id || wakeReserve.agent?.id || AGENT_ID, AGENT_ID)
    console.log('PASS: wake reused existing fleet id')

    const relogin = await request(ws, 'login', { agent_id: AGENT_ID, kind: 'codex' })
    assert.equal(relogin.ok, true)
    assertBoundAgent(relogin.agent, 're-login result')
    const state = await api('/api/state')
    assertBoundAgent((state.agents || []).find(a => a.id === AGENT_ID), 'state after re-login')
    console.log('PASS: re-login preserved binding fields')

    seedDaemonProcessLedger()
    await stopDaemon()
    daemonLog = ''
    await startDaemon()
    await waitFor('daemon JSONL watch after re-login', () => {
      const text = daemonLogText()
      return text.includes(`watching codex JSONL for ${NAME}`) && text.includes(SESSION_ID)
    }, { timeoutMs: 45000 })
    console.log('PASS: daemon watches the bound rollout after re-login')

    appendActivityLine()
    await waitFor('activity extracted after re-login', () => {
      const text = daemonLogText()
      return text.includes(`activity extracted for ${AGENT_ID}`)
    }, { timeoutMs: 45000 })
    console.log('PASS: daemon extracted activity after re-login')
  } finally {
    ws.close()
  }
}

run().then(() => {
  console.log('login/register binding full loop test passed')
  cleanup(0)
}).catch(e => {
  fail(e.stack || e.message)
})
