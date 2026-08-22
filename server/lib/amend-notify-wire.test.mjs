// An amend notifies, proven across the wire it crosses in production.
//
// The store-level tests next door prove that an amend now lands unread and that
// its delivery resolves to `notified`. Neither is delivery. This project has
// shipped three notification paths that were green on both ends with nothing
// between them, so the sender's function and the receiver's function passing is
// exactly the evidence that means nothing here.
//
// So this spawns the real unified server, opens a real fleet socket as the
// recipient's MCP channel, sends a real chat and then a real amend of it, and
// asserts the 📬 frame arrives on that channel carrying the amended text. That
// is the MCP/harness path, which is the only path that earns the word
// delivered.
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

async function openFleetWs(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error))
      else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Generous on purpose, not tuned. This box runs dozens of agents and the first
// version of this file waited 5s, which is the same order as the observed
// spread of a passing run (11-19s wall clock) — so it failed intermittently on
// load and told me the amend had not notified when it had. A flaky RED at the
// final gate gets acted on, which makes it worse than no test at all. Nothing
// here is measuring latency: a notification that arrives in 200ms and one that
// arrives in 20s both prove the same thing, so the ceiling only has to be
// beyond any plausible scheduling delay.
const ARRIVAL_CEILING_MS = 60_000

// Resolves as soon as the condition holds; the ceiling only bounds a hang.
async function waitUntil(condition, describe) {
  const deadline = Date.now() + ARRIVAL_CEILING_MS
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${ARRIVAL_CEILING_MS}ms waiting for: ${describe()}`)
    await sleep(25)
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`HTTP ${res.statusCode}: ${body}`)); return }
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
  })
}

async function waitForWakeStatuses(port, traceId, operations, expectedCount = 1, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let statuses = []
  while (Date.now() < deadline) {
    const traces = await getJson(`https://127.0.0.1:${port}/api/diagnostics/control-plane-traces?trace_id=${encodeURIComponent(traceId)}`)
    statuses = traces.trace.events
      .filter(entry => operations.includes(entry.operation))
      .map(entry => `${entry.operation}:${entry.status}`)
    if (statuses.length >= expectedCount) return statuses
    await sleep(25)
  }
  return statuses
}

test('an amend reaches the recipient channel as a notification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-amend-notify-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
  await store.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient', labels: [], registered_at: now, last_seen: now })
  await store.ensureSubscription({ owner: 'fleet:recipient', query: 'to:me', notificationPolicy: 'immediate' })
  store.close()

  const port = await unusedPort()
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
  let recipientWs
  let senderWs
  try {
    await waitForServer(child)

    recipientWs = await openFleetWs(port)
    await request(recipientWs, 'recipient-login', 'login', {
      operation_id: 'amend-notify-wire-login',
      agent_id: 'fleet:recipient',
      machine_id: 'mini',
      env_name: 'testing',
    })
    // Every 📬 that lands on this channel, in order, with its text — this is the
    // recipient surface and nothing stands in for it.
    const notifications = []
    recipientWs.on('message', raw => {
      const frame = JSON.parse(String(raw))
      if (frame.event !== 'channel-notification') return
      notifications.push(String(frame.data?.text || frame.data?.message || ''))
      const ackId = frame.data?.metadata?.wake_ack_id
      if (ackId) {
        recipientWs.send(JSON.stringify({ id: 100, type: 'channel-notification-ack', agent: 'fleet:recipient', ack_id: ackId }))
      }
    })

    senderWs = await openFleetWs(port)
    // The positive control. Without it, an empty `notifications` at the end
    // would say nothing about amends — only that this rig never delivers.
    const sent = await request(senderWs, 2, 'chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'the question, answered wrong the first time',
      _tempId: 'amend-notify-wire-original',
    })
    assert.equal(sent.ok, true)
    const originalId = sent.event_ids[0]

    await waitUntil(
      () => notifications.length >= 1,
      () => `control: an ordinary chat to notify this channel. Saw: ${JSON.stringify(notifications)}`,
    )

    // The amend. This is what an agent does when it answers Skip by correcting
    // the message it already sent him.
    const amended = await request(senderWs, 3, 'amend', {
      from: 'fleet:sender',
      event_id: originalId,
      message: 'THE ACTUAL ANSWER',
    })
    assert.equal(amended.ok, true)
    assert.equal(amended.event_id, originalId, 'an amend chains off the original')

    await waitUntil(
      () => notifications.length >= 2,
      () => `the amend to notify — this is the whole defect. Saw: ${JSON.stringify(notifications)}`,
    )
    assert.match(notifications[1], /THE ACTUAL ANSWER/, `the notification must carry the amended text, not the text it replaced. Saw: ${JSON.stringify(notifications)}`)
  } finally {
    recipientWs?.close()
    senderWs?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})

// The other recipient shape, and the one Skip's agent was NOT. A hibernating
// agent has no open fleet socket; its only reach is the daemon route. The
// amend handler skips a recipient with neither, which is right — a routeless
// mailbox is accepted mail that can never be delivered — so the question is
// whether an agent with a route but no socket still gets a wake requested.
//
// It cannot be answered by watching a pane from here, so it is answered where
// the server records it: the control plane. No daemon is connected in this rig,
// so the wake defers at `no-daemon` — and that is the point. Reaching
// `wake.request` at all means the amend entered the daemon wake path instead of
// being dropped, which is the leg the store tests cannot see.
test('an amend requests a daemon wake for a recipient with no open socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-amend-daemon-wake-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
  await store.upsertAgent({ id: 'fleet:sleeper', friendly_name: 'sleeper', labels: [], registered_at: now, last_seen: now })
  await store.ensureSubscription({ owner: 'fleet:sleeper', query: 'to:me', notificationPolicy: 'immediate' })
  // A route and no socket: this is what hibernating looks like to the server.
  store.setAgentDaemonRoute('fleet:sleeper', 'mini:testing')
  store.close()

  const port = await unusedPort()
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
  let senderWs
  try {
    await waitForServer(child)
    senderWs = await openFleetWs(port)

    // Control: an ordinary chat to this same recipient, so a later zero cannot
    // be blamed on the rig or on the recipient's shape.
    const sent = await request(senderWs, 2, 'chat', {
      from: 'fleet:sender',
      to: 'sleeper',
      message: 'original, to a hibernating recipient',
      metadata: { trace_id: 'amend-daemon-chat-control' },
      _tempId: 'amend-daemon-wake-original',
    })
    assert.equal(sent.ok, true)
    const chatStatuses = await waitForWakeStatuses(port, 'amend-daemon-chat-control', ['wake.request'], 1, ARRIVAL_CEILING_MS)
    assert.ok(chatStatuses.length >= 1, `control: an ordinary chat must request a daemon wake, got ${JSON.stringify(chatStatuses)}`)

    const amended = await request(senderWs, 3, 'amend', {
      from: 'fleet:sender',
      event_id: sent.event_ids[0],
      message: 'the amended answer, to a hibernating recipient',
      trace_id: 'amend-daemon-wake-proof',
    })
    assert.equal(amended.ok, true)

    const amendStatuses = await waitForWakeStatuses(port, 'amend-daemon-wake-proof', ['wake.request'], 1, ARRIVAL_CEILING_MS)
    assert.ok(
      amendStatuses.length >= 1,
      `an amend must request a daemon wake for a socketless recipient, got ${JSON.stringify(amendStatuses)}`,
    )
  } finally {
    senderWs?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
