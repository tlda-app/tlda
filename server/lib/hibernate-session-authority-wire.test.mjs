// Hibernation crosses two process boundaries: a caller asks the server over the
// fleet socket, the server asks the owning daemon over the daemon socket, and
// only the daemon can actually kill anything. Calling the handler and the RPC in
// one process would prove neither — and the failure this covers is exactly a
// severed one reporting health, because kill-session answers `ok` when the
// daemon has no terminal binding and did nothing at all.
//
// So these run a real server on a real port with its own database, a real
// daemon socket answering the RPC, and read the durable runtime_status_history
// rows back off disk afterwards. The negative case is the load-bearing one: a
// no-ledger agent whose process is still up must come back as an error with no
// status written and no success ack. The ledger-backed case is its positive
// control — same wire, same handler, one field different — because a negative
// test that would also pass against a broken server proves nothing.
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

const AGENT_ID = 'fleet:hibernate-wire'
const DAEMON_KEY = 'mini:testing'

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

async function openDaemon(port, { onRpc }) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet-daemon`, { rejectUnauthorized: false })
  const rpcs = []
  ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.type !== 'rpc') return
    rpcs.push(message)
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
    const timeout = setTimeout(() => reject(new Error('daemon welcome timed out')), 20_000)
    const onMessage = raw => {
      if (JSON.parse(String(raw)).type !== 'daemon-welcome') return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve()
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
  return { ws, rpcs }
}

// A fleet client, which is what todd is when it asks for a hibernation.
async function openFleetClient(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  const frames = []
  ws.on('message', raw => frames.push(JSON.parse(String(raw))))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let nextId = 1
  async function request(msg, timeoutMs = 30_000) {
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

async function seedAgent(dbPath) {
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  try {
    await store.upsertAgent({
      id: AGENT_ID,
      friendly_name: 'hibernate-wire',
      labels: [],
      registered_at: now,
      last_seen: now,
      dead: false,
      metadata: { kind: 'claude' },
    })
    store.setAgentDaemonRoute(AGENT_ID, DAEMON_KEY)
  } finally {
    store.close()
  }
}

// The durable record, read straight off disk rather than through the server that
// is under test.
function runtimeStatusRows(dbPath) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare(
      'SELECT kind, status, from_ts FROM runtime_status_history WHERE fleet_id = ? ORDER BY id',
    ).all(AGENT_ID)
  } finally {
    db.close()
  }
}

async function runHibernate({ killSessionReply }) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-hibernate-authority-'))
  const dbPath = join(dir, 'fleet.db')
  await seedAgent(dbPath)
  const port = await unusedPort()
  const child = startServer({ dir, dbPath, port })
  let daemon = null
  let client = null
  try {
    await waitForServer(child)
    daemon = await openDaemon(port, { onRpc: () => killSessionReply })
    client = await openFleetClient(port)
    const frame = await client.request({ type: 'hibernate-session', agent: AGENT_ID })
    // Read the durable rows while the server is still up but after it replied.
    await new Promise(resolve => setTimeout(resolve, 250))
    return { frame, rpcs: daemon.rpcs, rows: runtimeStatusRows(dbPath) }
  } finally {
    client?.ws?.close()
    daemon?.ws?.close()
    await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('NEGATIVE: hibernate on a no-ledger agent errors, writes no status, and sends no success ack', { timeout: 180_000 }, async () => {
  // What the daemon answers when it has no terminal binding for the agent: it
  // did not look at tmux and did not kill anything, and the process is still up.
  const { frame, rpcs, rows } = await runHibernate({
    killSessionReply: { ok: true, already_unavailable: true, terminal_unresolved: true, reason: 'terminal already unavailable' },
  })

  assert.equal(rpcs.length, 1, 'the server should still have asked the owning daemon')
  assert.equal(rpcs[0].op, 'kill-session')

  assert.ok(frame.error, `expected an error frame, got ${JSON.stringify(frame)}`)
  assert.match(
    frame.error.message || String(frame.error),
    /no terminal binding/,
    'the error must name why nothing was hibernated',
  )
  assert.equal(frame.result, undefined, 'a no-op must not be acknowledged as a result')
  assert.notEqual(frame.result?.ok, true, 'a no-op must never ack success')

  assert.deepEqual(
    rows,
    [],
    `no runtime status may be written for an agent nothing was done to; got ${JSON.stringify(rows)}`,
  )
})

test('POSITIVE CONTROL: hibernate on a ledger-backed agent succeeds and still writes no server-authored status', { timeout: 180_000 }, async () => {
  const { frame, rpcs, rows } = await runHibernate({
    killSessionReply: { ok: true },
  })

  assert.equal(rpcs.length, 1)
  assert.equal(rpcs[0].op, 'kill-session')

  assert.equal(frame.error, undefined, `expected success, got ${JSON.stringify(frame)}`)
  assert.equal(frame.result?.ok, true, 'a real kill is acknowledged')

  // The kill is real, but publishing it is the daemon's inventory to do. The
  // server must not author the hibernation itself on the way past.
  assert.deepEqual(
    rows,
    [],
    `the server must not author hibernation status; daemon inventory publishes it. got ${JSON.stringify(rows)}`,
  )
})
