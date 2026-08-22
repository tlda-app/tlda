// A native subagent has no session of its own, so no daemon inventory ever
// mentions it and no complete batch fills it in — `validateDaemonAgentStatusBatch`
// only fills in agents routed to the reporting daemon. Its liveness can only be
// DERIVED from its parent's, which makes "who may write it, on what evidence"
// the whole question.
//
// Real server, real daemon socket, real fleet client, and the child is created
// through `subagent-observed` rather than hand-seeded — a fixture built by hand
// would not have told us that such a child projects `liveness: "unknown"` and
// never `alive`, which is the fact the reconciler's skip condition turns on.
// Provenance is read back off the roster projection.
//
// Pinned here:
//   1. kill-session authors no descendant row — it observed that it asked
//   2. restart-agent-mcp authors none either, for the same reason
//   3. the ensuing daemon status batch authors it, with daemon generation
//   4. and does so with the parent UNCHANGED, which is the only thing that
//      reconciles a child created under an already-hibernating parent
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'

const PARENT_ID = 'fleet:descendant-parent'
const DAEMON_KEY = 'mini:testing'
const BOOT_ID = 4242

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

async function openDaemon(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet-daemon`, { rejectUnauthorized: false })
  ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.type !== 'rpc') return
    ws.send(JSON.stringify({ type: 'rpc-reply', id: message.id, result: { ok: true } }))
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({
    type: 'daemon-hello',
    machine_id: 'mini',
    env_name: 'testing',
    boot_id: BOOT_ID,
    install_path: import.meta.dirname,
    hostname: 'mini.local',
    version: 'test',
  }))
  await new Promise(resolve => setTimeout(resolve, 600))
  // The parent's status as the daemon reports it. The child is deliberately
  // never in this list: a native subagent is never in an inventory, which is
  // the entire reason its liveness has to be derived.
  ws.reportParent = (reportSeq, status) => ws.send(JSON.stringify({
    type: 'agent-status',
    daemon_key: DAEMON_KEY,
    daemon_boot_id: BOOT_ID,
    report_seq: reportSeq,
    snapshot_complete: true,
    ts: new Date().toISOString(),
    agents: [{
      agent_id: PARENT_ID,
      status,
      activity: 'unknown',
      tool: null,
      identity: { friendly_name: 'descendant-parent', runtime_kind: 'claude' },
    }],
  }))
  return ws
}

async function openFleetClient(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  const frames = []
  ws.on('message', raw => frames.push(JSON.parse(String(raw))))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let nextId = 1
  async function request(msg, timeoutMs = 40_000) {
    const id = nextId++
    ws.send(JSON.stringify({ id, ...msg }))
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = frames.find(f => f.id === id)
      if (frame) return frame
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`no response frame for ${msg.type}`)
  }
  return { ws, request, frames }
}

async function seedParent(dbPath) {
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  try {
    await store.upsertAgent({
      id: PARENT_ID,
      friendly_name: 'descendant-parent',
      labels: [],
      registered_at: now,
      last_seen: now,
      dead: false,
      metadata: { kind: 'claude' },
    })
    store.setAgentDaemonRoute(PARENT_ID, DAEMON_KEY)
  } finally {
    store.close()
  }
}

function statusRows(dbPath, agentId) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare('SELECT kind, status FROM runtime_status_history WHERE fleet_id = ? ORDER BY id').all(agentId)
  } finally {
    db.close()
  }
}

// Straight off disk: /api/fleet-table does not project route_present, and the
// child being unrouted is the precondition that makes this the case under test.
function hasRoute(dbPath, agentId) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return !!db.prepare('SELECT 1 FROM agent_daemon_routes WHERE agent_id = ?').get(agentId)
  } finally {
    db.close()
  }
}

async function rosterRow(port, agentId) {
  const res = await fetch(`https://127.0.0.1:${port}/api/fleet-table?limit=500`)
  const table = await res.json()
  return (table.agents || []).find(a => a.id === agentId) || null
}

const settle = (ms = 800) => new Promise(resolve => setTimeout(resolve, ms))

async function withFamily(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-descendant-authority-'))
  const dbPath = join(dir, 'fleet.db')
  await seedParent(dbPath)
  const port = await unusedPort()
  const server = startServer({ dir, dbPath, port })
  let daemon = null
  let client = null
  try {
    await waitForServer(server)
    daemon = await openDaemon(port)
    client = await openFleetClient(port)

    async function observeChild() {
      const frame = await client.request({ type: 'subagent-observed', parent_agent_id: PARENT_ID, child_name: 'worker' })
      const childId = frame?.result?.agent?.id
      assert.ok(childId, `subagent-observed did not return a child: ${JSON.stringify(frame)}`)
      await settle(400)
      // The control only means something if the child starts unsettled. A child
      // already recorded hibernating would satisfy every assertion below without
      // anything having reconciled it.
      assert.deepEqual(statusRows(dbPath, childId), [], 'child must start with no runtime status row')
      assert.equal(hasRoute(dbPath, childId), false, 'the child must be unrouted, or it is not this case')
      assert.equal(hasRoute(dbPath, PARENT_ID), true, 'the parent must be routed, or the batch cannot report it')
      const row = await rosterRow(port, childId)
      assert.equal(row?.runtime_status?.evidence?.liveness, 'unknown', 'a native child starts unknown')
      return childId
    }

    return await run({ port, dbPath, client, daemon, observeChild })
  } finally {
    client?.ws?.close()
    daemon?.close()
    await stopServer(server)
    rmSync(dir, { recursive: true, force: true })
  }
}

async function assertReconciledByDaemon(port, childId) {
  const row = await rosterRow(port, childId)
  assert.equal(row?.runtime_status?.status, 'hibernating', `descendant not reconciled: ${JSON.stringify(row?.runtime_status)}`)
  assert.equal(row?.runtime_status?.evidence?.liveness_source, 'daemon-agent-status',
    'a derived row must carry daemon provenance, not a handler source')
  assert.equal(row?.runtime_status?.evidence?.liveness_generation?.daemon_key, DAEMON_KEY)
  assert.equal(row?.runtime_status?.evidence?.liveness_generation?.report_seq != null, true)
  assert.equal(row?.runtime_status?.evidence?.liveness_generation?.agent_id, PARENT_ID,
    'the generation points at the parent observation it was derived from')
}

test('kill-session authors no descendant row; the daemon batch does, with generation', { timeout: 240_000 }, async () => {
  await withFamily(async ({ port, dbPath, client, daemon, observeChild }) => {
    daemon.reportParent(1, 'awake')
    await settle(500)
    const childId = await observeChild()

    const frame = await client.request({ type: 'kill-session', agent: PARENT_ID })
    assert.equal(frame.error, undefined, `kill-session should succeed: ${JSON.stringify(frame)}`)
    await settle()

    assert.deepEqual(statusRows(dbPath, childId), [], 'the request handler must not author a descendant row')

    daemon.reportParent(2, 'hibernating')
    await settle()
    await assertReconciledByDaemon(port, childId)
  })
})

test('restart-agent-mcp authors no descendant row before daemon status', { timeout: 240_000 }, async () => {
  await withFamily(async ({ dbPath, client, daemon, observeChild }) => {
    daemon.reportParent(1, 'awake')
    await settle(500)
    const childId = await observeChild()

    // Whether the restart completes is not what is under test. The claim is that
    // it authors no descendant liveness on the way through.
    await client.request({ type: 'restart-agent-mcp', agent: PARENT_ID }).catch(() => null)
    await settle()

    assert.deepEqual(
      statusRows(dbPath, childId),
      [],
      'restart must not pre-write hibernation for native children',
    )
  })
})

test('INHERITED: a child under an ALREADY hibernating parent is reconciled with no parent transition', { timeout: 240_000 }, async () => {
  await withFamily(async ({ port, client, daemon, observeChild }) => {
    // Parent goes hibernating first, so the child below is created underneath a
    // parent that is already settled. No request handler ever runs for it, and
    // no later batch reports a parent status CHANGE — so nothing keyed on a
    // transition can ever reach this child.
    daemon.reportParent(1, 'hibernating')
    await settle()
    const childId = await observeChild()

    daemon.reportParent(2, 'hibernating')
    await settle()

    await assertReconciledByDaemon(port, childId)

    const broadcasts = () => client.frames.filter(frame => frame.event === 'agents-delta').length
    const beforeSteadyBatch = broadcasts()
    daemon.reportParent(3, 'hibernating')
    await settle()
    assert.equal(broadcasts(), beforeSteadyBatch, 'an unchanged complete batch must perform no descendant broadcast')
  })
})
