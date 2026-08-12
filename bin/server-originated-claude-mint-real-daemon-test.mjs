#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn as spawnProcess, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocket } from 'ws'

const PORT = Number(process.env.PORT || (6607 + (process.pid % 1000)))
const DB = `/tmp/server-originated-claude-mint-${process.pid}.db`
const CONFIG_DIR = `/tmp/server-originated-claude-mint-config-${process.pid}`
const PROJECTS_DIR = `${CONFIG_DIR}/projects`
const HOME_DIR = `${CONFIG_DIR}/home`
const ENV_NAME = 'test'
const MACHINE_ID = `real-claude-mint-box-${process.pid}`
const REQUESTER_ID = 'fleet:real-claude-mint-requester'
const REQUESTER_NAME = 'real-claude-mint-requester'
const MINT_NAME = `real-claude-mint-gate-${process.pid}`
const PHRASE = `real-claude-mint-proof-${process.pid}`
const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
if (useTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const proto = useTls ? 'https' : 'http'
const wsProto = useTls ? 'wss' : 'ws'
const wsOpts = useTls ? { rejectUnauthorized: false } : {}
const base = `${proto}://localhost:${PORT}`

let srv = null
let daemon = null
let mcpClient = null
let mcpTransport = null
let serverLog = ''
let daemonLog = ''

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function bestEffortCleanup(label, fn) {
  try {
    return fn()
  } catch (e) {
    // Cleanup must not replace the test failure or success result.
    if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup ${label} failed: ${e.message}`)
    return null
  }
}

function cleanup(code) {
  bestEffortCleanup('mcp client close', () => mcpClient?.close?.())
  bestEffortCleanup('mcp transport close', () => mcpTransport?.close?.())
  bestEffortCleanup('daemon kill', () => daemon?.kill('SIGTERM'))
  bestEffortCleanup('server kill', () => srv?.kill('SIGKILL'))
  bestEffortCleanup('tmux session kill', () => spawnSync('tmux', ['kill-session', '-t', `fleet-${MINT_NAME}`], { stdio: 'ignore' }))
  for (const suffix of ['', '-wal', '-shm']) {
    bestEffortCleanup(`db cleanup ${suffix || 'main'}`, () => rmSync(`${DB}${suffix}`, { force: true }))
  }
  bestEffortCleanup('config dir cleanup', () => rmSync(CONFIG_DIR, { recursive: true, force: true }))
  process.exit(code)
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  cleanup(1)
}

async function waitHealth() {
  let lastError = null
  for (let i = 0; i < 240; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`)
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

function request(ws, type, body = {}, timeoutMs = 30_000) {
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

async function reserveAndLoginRequester() {
  const ws = await openFleet()
  try {
    await request(ws, 'reserve-shell', {
      agent_id: REQUESTER_ID,
      name: REQUESTER_NAME,
      machine_id: MACHINE_ID,
      env_name: ENV_NAME,
      daemon_key: `${MACHINE_ID}:${ENV_NAME}`,
      metadata: { permissionGrant: 'ops' },
    })
    await request(ws, 'login', {
      agent_id: REQUESTER_ID,
      kind: 'codex',
      machine_id: MACHINE_ID,
      env_name: ENV_NAME,
      daemon_key: `${MACHINE_ID}:${ENV_NAME}`,
    })
  } finally {
    ws.close()
  }
}

async function waitForDaemonConnected(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (serverLog.includes(`daemon=${MACHINE_ID}:${ENV_NAME}`)) return
    await sleep(100)
  }
  fail(`real daemon did not connect\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`)
}

async function stateAgent(predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let lastAgents = []
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/api/state`)
    const state = await r.json()
    lastAgents = state.agents || []
    const agent = (state.agents || []).find(predicate)
    if (agent) return agent
    await sleep(500)
  }
  stateAgent.lastAgents = lastAgents
  return null
}
stateAgent.lastAgents = []

async function waitForChatFrom(agentId, timeoutMs = 240_000) {
  const ws = await openFleet()
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const events = await request(ws, 'fleet-search', {
        query: PHRASE,
        agent: REQUESTER_ID,
        eventTypes: ['chat'],
        historyOnly: true,
        eventOnly: true,
        limit: 20,
      })
      const found = (events.results || []).find(e => e.from === agentId && String(e.text || '').includes(PHRASE))
      if (found) return found
      await sleep(1000)
    }
    return null
  } finally {
    ws.close()
  }
}

async function capturePane(agentId) {
  const ws = await openFleet()
  try {
    return await request(ws, 'capture-pane', { agent: agentId, lines: 5 }, 30_000)
  } finally {
    ws.close()
  }
}

function captureMintTmuxPane() {
  const result = spawnSync('tmux', ['capture-pane', '-pt', `fleet-${MINT_NAME}`, '-S', '-160'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout : result.stderr || result.error?.message || ''
}

async function startMcpClient() {
  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp-server/index.mjs'],
    env: {
      ...process.env,
      TLDA_CONFIG_DIR: CONFIG_DIR,
      TLDA_DAEMON_CONFIG_DIR: CONFIG_DIR,
      TLDA_ENV: ENV_NAME,
      TLDA_MACHINE_ID: MACHINE_ID,
      FLEET_DAEMON_KEY: `${MACHINE_ID}:${ENV_NAME}`,
      FLEET_ID: REQUESTER_ID,
      FLEET_LOCAL_ID: 'local-real-mint-requester',
      FLEET_MINT_ID: 'local-real-mint-requester',
      FLEET_NAME: REQUESTER_NAME,
      FLEET_HARNESS: 'codex',
      FLEET_TMUX_SESSION: 'fleet-real-mint-requester',
      TLDA_MCP_FLEET_ONLY: '1',
      TLDA_FLEET_DURABLE_SEND_DEADLINE_MS: '180000',
    },
    cwd: process.cwd(),
  })
  mcpClient = new Client({ name: 'real-mint-gate-test', version: '1.0.0' })
  await mcpClient.connect(mcpTransport)
}

async function run() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  mkdirSync(PROJECTS_DIR, { recursive: true })
  mkdirSync(`${HOME_DIR}/.codex/sessions`, { recursive: true })
  mkdirSync(`${HOME_DIR}/.claude/sessions`, { recursive: true })
  writeFileSync(`${CONFIG_DIR}/server.yaml`, '')
  writeFileSync(`${CONFIG_DIR}/daemon.yaml`, `machineId: ${MACHINE_ID}
models:
  default: sonnet
  values:
    sonnet:
      id: sonnet
      harness:
        kind: claude
        required: []
        preferences: []
        controls: true
      group: claude
      level: 3
      description: Claude Sonnet
      options:
        effort:
          default: low
          values:
            low: {}
environments:
  default: ${ENV_NAME}
  values:
    ${ENV_NAME}:
      database: ${base}
      store: ${base}
      licenseKey: ""
regions:
  machine: ["**"]
profiles:
  ops:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
  app-dev:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
grants:
  localhost: ops
  "${REQUESTER_ID}": ops
default: ops
terminalInputAllowed: false
statusScanSeconds: 1
jsonlTailIdleSeconds: 600
`)
  srv = spawnProcess(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      TLDA_FLEET_DB: DB,
      TLDA_CONFIG_DIR: CONFIG_DIR,
      TLDA_DAEMON_CONFIG_DIR: CONFIG_DIR,
      PROJECTS_DIR,
      TLDA_ENV: ENV_NAME,
      TLDA_DEV_SERVER: '1',
      TLDA_SPAWN_LOGIN_DEADLINE_MS: '180000',
      TLDA_SPAWN_MAILBOX_DEADLINE_MS: '240000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', d => { serverLog += d })
  srv.stderr.on('data', d => { serverLog += d })
  await waitHealth()

  daemon = spawnProcess(process.execPath, ['bin/fleet-daemon.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TLDA_CONFIG_DIR: CONFIG_DIR,
      TLDA_DAEMON_CONFIG_DIR: CONFIG_DIR,
      PROJECTS_DIR,
      TLDA_ENV: ENV_NAME,
      TLDA_MACHINE_ID: MACHINE_ID,
      TLDA_DEV_DAEMON: base,
      HOME: HOME_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout.on('data', d => { daemonLog += d })
  daemon.stderr.on('data', d => { daemonLog += d })
  await waitForDaemonConnected()
  await reserveAndLoginRequester()
  await startMcpClient()

  const result = await mcpClient.callTool({
    name: 'delegate',
    arguments: {
      mint: {
        name: MINT_NAME,
        cwd: process.cwd(),
        model: 'sonnet',
        effort: 'low',
        permissionRequest: 'ops',
      },
      description: 'Real route gate proof',
      message: `Reply to ${REQUESTER_NAME} with exactly ${PHRASE}, then stop.`,
      operation_id: `real-mint-gate:${process.pid}`,
    },
  })
  const text = result.content?.map(part => part.text || '').join('\n') || ''
  assert.equal(result.isError, undefined, text)
  const agentId = text.match(/agent_id:\s*`?([^`\s]+)`?/)?.[1] || null
  assert.ok(agentId, `delegate(mint:) returned no agent_id:\n${text}`)
  const shell = await stateAgent(a => a.id === agentId && a.friendly_name === MINT_NAME, 60_000)
  assert.ok(shell, `minted shell not found for ${agentId}; result:\n${text}\nTMUX PANE:\n${captureMintTmuxPane()}\nSTATE AGENTS:\n${JSON.stringify(stateAgent.lastAgents, null, 2)}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`)
  await capturePane(agentId)
  console.log(`PASS: delegate(mint:) committed route-present shell ${agentId}`)

  const live = await stateAgent(a => a.id === agentId && a.metadata?.shell !== true, 180_000)
  assert.ok(live, `minted agent never logged in as live ${agentId}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`)
  console.log(`PASS: real daemon-spawned agent logged in ${agentId}`)

  const chat = await waitForChatFrom(agentId)
  assert.ok(chat, `minted agent did not answer with ${PHRASE}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`)
  console.log('PASS: real delegate(mint:) agent answered through chat')
  console.log('ALL CHECKS PASSED')
  cleanup(0)
}

run().catch(e => fail(`${e.stack || e.message || e}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`))
setTimeout(() => fail(`overall test timeout\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`), 360_000)
