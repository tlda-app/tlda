// Step 1 of the notification proposal: the return notice is handed over at
// login, not carried on a wake.
//
// `return_notice` is now written by the server's login handler and read by
// `mcp-server/fleet-tools.mjs`. Both ends contain the literal, which is exactly
// the shape AGENTS.md warns is worth nothing — the login reply is assembled
// field by field, so a key that is not enumerated is dropped in silence with
// both ends still grepping clean. So this asserts it over a real socket against
// a real server.
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', c => { output += c })
  child.stderr.on('data', c => { output += c })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

async function openFleetWs(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return ws
}

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error)); else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

const HOURS_3 = 3 * 60 * 60 * 1000

async function withServer(seed, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-login-return-notice-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  await seed(store)
  store.close()
  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath, TLDA_DEV_SERVER: '1', TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let ws
  try {
    await waitForServer(child)
    ws = await openFleetWs(port)
    await fn(ws, port)
  } finally {
    ws?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

const loginPayload = (id, opId) => ({
  operation_id: opId, agent_id: id, machine_id: 'mini', env_name: 'testing',
})

test('an agent that was away is told so, over the wire', async () => {
  await withServer(async store => {
    const away = new Date(Date.now() - HOURS_3).toISOString()
    await store.upsertAgent({
      id: 'fleet:sleeper', friendly_name: 'sleeper', labels: [],
      registered_at: away, last_seen: away,
    })
  }, async ws => {
    const result = await request(ws, 'l1', 'login', loginPayload('fleet:sleeper', 'op-away'))
    assert.equal(result.ok, true)
    assert.match(
      String(result.return_notice || ''),
      /hibernating for 3 hours/,
      `the login reply must carry the return notice. Got: ${JSON.stringify(result.return_notice)}`,
    )
  })
})

// The reason the duration gate exists. `last_seen` is advanced by heartbeats
// while an agent runs, so a reconnecting MCP is seconds stale, not hours — and
// telling it that it was hibernating would be both false and constant.
test('a reconnecting agent is told nothing', async () => {
  await withServer(async store => {
    const now = new Date().toISOString()
    await store.upsertAgent({
      id: 'fleet:busy', friendly_name: 'busy', labels: [],
      registered_at: now, last_seen: now,
    })
  }, async ws => {
    const result = await request(ws, 'l1', 'login', loginPayload('fleet:busy', 'op-reconnect'))
    assert.equal(result.ok, true)
    assert.equal(result.return_notice, undefined, 'a reconnect is not a return')
  })
})

// A shell is reserved at mint and cleared on first login, so its presence means
// this agent has never run. It is not coming back from anywhere.
test('a freshly minted shell is told nothing on its first login', async () => {
  await withServer(async store => {
    const old = new Date(Date.now() - HOURS_3).toISOString()
    await store.upsertAgent({
      id: 'fleet:fresh', friendly_name: 'fresh', labels: [],
      registered_at: old, last_seen: old, metadata: { shell: true },
    })
  }, async ws => {
    const result = await request(ws, 'l1', 'login', loginPayload('fleet:fresh', 'op-fresh'))
    assert.equal(result.ok, true)
    assert.equal(result.return_notice, undefined, 'a shell that has never run is not returning')
  })
})

// The §S1 case: the reanimate notice could not be delivered by the path that
// claimed to send it. Parked on the agent, it is handed over at login and then
// cleared, so a later login does not repeat it.
test('a parked reanimate notice is delivered once and then gone', async () => {
  await withServer(async store => {
    const now = new Date().toISOString()
    await store.upsertAgent({
      id: 'fleet:back', friendly_name: 'back', labels: [],
      registered_at: now, last_seen: now,
      metadata: { pendingReturnNotice: 'You were killed 2 hours ago and reanimated.' },
    })
  }, async ws => {
    const first = await request(ws, 'l1', 'login', loginPayload('fleet:back', 'op-back-1'))
    assert.match(String(first.return_notice || ''), /reanimated/, 'the parked notice must be handed over')

    const second = await request(ws, 'l2', 'login', loginPayload('fleet:back', 'op-back-2'))
    assert.equal(second.return_notice, undefined, 'and not handed over twice')
  })
})
