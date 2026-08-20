#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn as spawnProcess, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocket } from 'ws'
import Database from 'better-sqlite3'
import { MintStore } from '../daemon/mint-store.mjs'
import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'

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
const MINT_MODEL = process.env.TLDA_REAL_MINT_MODEL || 'sonnet'
const LOGIN_TIMEOUT_MS = Number(process.env.TLDA_REAL_MINT_LOGIN_TIMEOUT_MS || 180_000)
const OVERALL_TIMEOUT_MS = Number(process.env.TLDA_REAL_MINT_OVERALL_TIMEOUT_MS || 360_000)
const DURABLE_SEND_DEADLINE_MS = Number(process.env.TLDA_REAL_MINT_DURABLE_SEND_DEADLINE_MS || 15_000)
const EXPECT_TIMEOUT_RETRY = DURABLE_SEND_DEADLINE_MS < 15_000
const OPERATION_ID = `real-mint-gate:${process.pid}`
const TASK_MESSAGE = `Reply to ${REQUESTER_NAME} with exactly ${PHRASE}, then stop.`
const TASK_CRITERIA = ['Receive the complete delegated message', 'Reply through fleet chat']
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

// The same poll against `/api/fleet-table`, which merges pending shell rows into
// a filtered roster read. `/api/state` cannot answer a question about a row that
// has not logged in yet; this can.
async function rosterAgent(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastAgents = []
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/api/fleet-table?filter=${encodeURIComponent(MINT_NAME)}`)
    const table = await r.json()
    lastAgents = table.agents || []
    const agent = lastAgents.find(predicate)
    if (agent) return agent
    await sleep(500)
  }
  rosterAgent.lastAgents = lastAgents
  return null
}
rosterAgent.lastAgents = []

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

async function waitForOutboxRetry(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const file = readdirSync(CONFIG_DIR).find(name => name.startsWith('mcp-fleet-transport-') && name.endsWith('.sqlite'))
    if (file) {
      const db = new Database(`${CONFIG_DIR}/${file}`, { readonly: true })
      const row = db.prepare('SELECT attempts, status, result_json FROM mcp_fleet_outbox WHERE operation_id = ?').get(OPERATION_ID)
      db.close()
      if (row?.attempts >= 2 && row.status === 'accepted') return row
    }
    await sleep(100)
  }
  return null
}

async function waitForDurableBinding(agentId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const mintStore = new MintStore(`${CONFIG_DIR}/daemon-mints.sqlite`, { defaultEnvName: ENV_NAME })
    const mintRow = mintStore.getByFleetId(agentId)
    mintStore.close()
    const permissionLedger = createPermissionLedger(`${CONFIG_DIR}/fleet-daemon.db`)
    const grant = permissionLedger.get(agentId)
    await permissionLedger.close()
    if (mintRow?.processState && mintRow?.sessionId && mintRow?.joinedAt && grant?.permissionGrant === 'ops' && grant?.sessionId) {
      return { mintRow, grant }
    }
    await sleep(100)
  }
  return null
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
      TLDA_FLEET_DURABLE_SEND_DEADLINE_MS: String(DURABLE_SEND_DEADLINE_MS),
      // No deadline override here. Nothing ever read
      // TLDA_FLEET_DURABLE_SEND_DEADLINE_MS -- the constant in fleet-tools.mjs is
      // hard-coded -- so this test always ran at the real 15s bound while
      // appearing to run at 180s. It is deleted rather than wired up: the mint
      // ack no longer waits on the minted agent's login, so 15s is no longer a
      // deadline this path cannot meet, and this test now proves that at the
      // bound the product actually uses.
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
    codex-sol:
      id: gpt-5.6-sol
      harness:
        kind: codex
        required: []
        preferences: []
        controls: true
      group: codex
      level: 3
      description: Codex Sol
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
        model: MINT_MODEL,
        effort: 'low',
        permissionRequest: 'ops',
      },
      description: 'Real route gate proof',
      message: TASK_MESSAGE,
      success_criteria: TASK_CRITERIA,
      operation_id: OPERATION_ID,
    },
  })
  const mintAckAt = Date.now()
  const text = result.content?.map(part => part.text || '').join('\n') || ''
  assert.equal(result.isError, undefined, text)
  if (EXPECT_TIMEOUT_RETRY) assert.match(text, /queued durably/, `forced deadline did not exercise the queued retry path:\n${text}`)
  let agentId = text.match(/agent_id:\s*`?([^`\s]+)`?/)?.[1] || null
  if (!agentId && EXPECT_TIMEOUT_RETRY) {
    const shell = await rosterAgent(a => a.name === MINT_NAME, 60_000)
    agentId = shell?.id || null
  }
  assert.ok(agentId, `delegate(mint:) returned or reconciled no agent_id:\n${text}`)

  // The bug this covers: the delegation was dropped whenever the mint's
  // acknowledgement outlived the client's 15s durable-send deadline, which a
  // Claude seat's login always does. So assert the task exists NOW -- before the
  // agent has logged in -- and that the login it is waiting for really does land
  // after that deadline. If login started arriving inside 15s this assertion
  // would stop being about the bug, and it says so rather than passing quietly.
  const preLoginTask = await (async () => {
    const ws = await openFleet()
    try {
      return await request(ws, 'my-task', { agent: agentId })
    } finally {
      ws.close()
    }
  })()
  const mintTaskId = text.match(/delegated \[([^\]]+)\]/)?.[1] || preLoginTask.task?.id || null
  assert.ok(mintTaskId, `delegate(mint:) produced no persisted task id:\n${text}`)
  assert.equal(preLoginTask.task?.id, mintTaskId, `mint task not attached before login:\n${JSON.stringify(preLoginTask, null, 2)}`)
  assert.equal(preLoginTask.task?.agent, agentId)
  assert.equal(preLoginTask.task?.message, TASK_MESSAGE)
  assert.deepEqual(preLoginTask.task?.success_criteria, TASK_CRITERIA)
  console.log(`PASS: task ${mintTaskId} attached to ${agentId} at mint, before the agent logged in`)
  if (EXPECT_TIMEOUT_RETRY) {
    const outboxRow = await waitForOutboxRetry()
    assert.ok(outboxRow, `operation ${OPERATION_ID} did not reach an accepted automatic retry`)
    const db = new Database(DB, { readonly: true })
    const sameNameRows = db.prepare('SELECT id FROM agents WHERE friendly_name = ? AND dead = 0').all(MINT_NAME)
    db.close()
    assert.equal(sameNameRows.length, 1, `retry reminted ${MINT_NAME}: ${JSON.stringify(sameNameRows)}`)
    assert.equal(sameNameRows[0].id, agentId)
    const retryResult = JSON.parse(outboxRow.result_json || '{}')
    assert.equal(retryResult.agent_id, agentId, `retry reconciled to a different seat: ${outboxRow.result_json}`)
    assert.equal(retryResult.task_id, mintTaskId, `retry reconciled to a different task: ${outboxRow.result_json}`)
    console.log(`PASS: timed-out operation retried as attempt ${outboxRow.attempts} onto the same seat and task without remint`)
  }
  // Not `/api/state`: its roster is `dead = 0 AND metadata.shell != 1`, so a row
  // that has been reserved but has not logged in is excluded by construction and
  // this could only ever have passed after login. It never ran to find out --
  // every mint failed above, at the drop this test now covers. `/api/fleet-table`
  // with a filter is the surface that merges pending shells back in, which is
  // where a reserved-but-not-yet-joined row is visible.
  const shell = await rosterAgent(a => a.id === agentId && a.name === MINT_NAME, 60_000)
  assert.ok(shell, `minted shell not found for ${agentId}; result:\n${text}\nTMUX PANE:\n${captureMintTmuxPane()}\nROSTER ROWS:\n${JSON.stringify(rosterAgent.lastAgents, null, 2)}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`)
  // The roster row is a projection and carries no `metadata`. This reason is
  // emitted by agent-runtime-status.mjs exactly when `metadata.shell` is set, so
  // it is how "reserved but not yet joined" reads on this surface -- and it is
  // the state the task above was attached in.
  assert.equal(shell.runtime_status?.reason, 'reserved-shell-unclaimed', `expected ${agentId} to still be an unclaimed reserved shell before login`)
  console.log(`PASS: delegate(mint:) committed reserved shell ${agentId} with its task`)

  const live = await stateAgent(a => a.id === agentId && a.metadata?.shell !== true, LOGIN_TIMEOUT_MS)
  assert.ok(live, `minted agent never logged in as live ${agentId}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`)
  const loginAfterAckMs = Date.now() - mintAckAt
  assert.ok(
    loginAfterAckMs > DURABLE_SEND_DEADLINE_MS,
    `login landed ${loginAfterAckMs}ms after the mint ack, inside the ${DURABLE_SEND_DEADLINE_MS}ms client durable-send deadline. The task-attached-before-login assertion above no longer exercises the timeout case; re-check what changed before trusting this suite.`,
  )
  console.log(`PASS: real daemon-spawned agent logged in ${agentId} ${loginAfterAckMs}ms after the mint ack (past the 15s client deadline)`)

  const durableBinding = await waitForDurableBinding(agentId)
  assert.ok(durableBinding, `mint ${agentId} did not reconcile durable process, session, joined, and permission-grant facts`)
  console.log(`PASS: ${agentId} has durable process, session, joined, and permission-grant facts`)

  // Route presence is checked here rather than beside the shell assertion above.
  // A reserved shell has no daemon address -- the route is published at login --
  // so capture-pane there answered `agent has no daemon address`, and the line
  // that claimed a "route-present shell" was claiming it of a row that by design
  // is not yet routed. It had never run: every mint failed before reaching it.
  await capturePane(agentId)
  console.log(`PASS: ${agentId} is route-present through its daemon after login`)

  const chat = await waitForChatFrom(agentId)
  assert.ok(chat, `minted agent did not answer with ${PHRASE}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`)
  console.log('PASS: real delegate(mint:) agent answered through chat')

  const lifecycleWs = await openFleet()
  try {
    await request(lifecycleWs, 'hibernate-session', { agent: agentId }, 60_000)
  } finally {
    lifecycleWs.close()
  }
  const hibernating = await rosterAgent(a => a.id === agentId && a.runtime_status?.status === 'hibernating', 60_000)
  assert.ok(hibernating, `hibernate succeeded but ${agentId} did not clear from the awake roster projection:\n${JSON.stringify(rosterAgent.lastAgents, null, 2)}`)
  console.log(`PASS: lifecycle hibernate durably cleared ${agentId} from awake roster state`)
  console.log('ALL CHECKS PASSED')
  cleanup(0)
}

run().catch(e => fail(`${e.stack || e.message || e}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`))
setTimeout(() => fail(`overall test timeout\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`), OVERALL_TIMEOUT_MS)
