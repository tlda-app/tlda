// Step 2 of the notification proposal: a refusal is distinguishable from
// silence.
//
// The claim is entirely about a state the server can reach, so it is asserted
// through the server's own control-plane trace over a real socket. Both ends
// contain the word `acknowledged`, and the ack handler reads named fields off
// the message — a nack that is not enumerated there is read as an ack, which
// would be worse than the timeout it replaces.
import assert from 'node:assert/strict'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { removeTempDir } from './test-support/remove-temp-dir.mjs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'

const ARRIVAL_CEILING_MS = 60_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
    await sleep(25)
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

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`HTTP ${res.statusCode}: ${body}`)); return }
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
  })
}

async function wakeNotifyStatuses(port, traceId) {
  const deadline = Date.now() + ARRIVAL_CEILING_MS
  let statuses = []
  while (Date.now() < deadline) {
    const traces = await getJson(`https://127.0.0.1:${port}/api/diagnostics/control-plane-traces?trace_id=${encodeURIComponent(traceId)}`)
    statuses = traces.trace.events
      .filter(e => e.operation === 'wake.mcp-notify')
      .map(e => `${e.operation}:${e.status}`)
    if (statuses.length >= 2) return statuses
    await sleep(25)
  }
  return statuses
}

// `responder` decides what the recipient's channel does with the notice.
async function withRecipient(responder, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-channel-nack-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
  await store.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient', labels: [], registered_at: now, last_seen: now })
  await store.ensureSubscription({ owner: 'fleet:recipient', query: 'to:me', notificationPolicy: 'immediate' })
  await store.close()

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
  let recipientWs, senderWs
  try {
    await waitForServer(child)
    recipientWs = await openFleetWs(port)
    // `metadata.kind` is what marks this socket as an MCP, sent the way the real
    // one sends it — loginBody carries `metadata: { kind }` and no top-level
    // field. Without it this recipient is not a notification target at all and
    // the traces come back empty, which is the gate working rather than the nack
    // failing.
    await request(recipientWs, 'r-login', 'login', {
      operation_id: 'channel-nack-login', agent_id: 'fleet:recipient',
      machine_id: 'mini', env_name: 'testing', metadata: { kind: 'claude' },
    })
    recipientWs.on('message', raw => {
      const frame = JSON.parse(String(raw))
      const ackId = frame.data?.metadata?.wake_ack_id
      if (frame.event !== 'channel-notification' || !ackId) return
      responder(recipientWs, ackId)
    })
    senderWs = await openFleetWs(port)
    await fn(senderWs, port)
  } finally {
    recipientWs?.close(); senderWs?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    removeTempDir(dir)
  }
}

test('a nack is recorded as a refusal, not a fallback', async () => {
  await withRecipient((ws, ackId) => {
    ws.send(JSON.stringify({
      id: 100, type: 'channel-notification-ack', agent: 'fleet:recipient',
      ack_id: ackId, acknowledged: false, reason: 'sender-is-recipient',
    }))
  }, async (senderWs, port) => {
    await request(senderWs, 2, 'chat', {
      from: 'fleet:sender', to: 'recipient', message: 'refused notice',
      metadata: { trace_id: 'nack-refused-proof' }, _tempId: 'nack-refused',
    })
    const statuses = await wakeNotifyStatuses(port, 'nack-refused-proof')
    assert.deepEqual(
      statuses,
      ['wake.mcp-notify:sent', 'wake.mcp-notify:refused'],
      'a declined notice must read as refused — not as a wedged process',
    )
  })
})

// The control that makes the above mean something: the same rig, the same
// message, one field different, and the server reaches a different state.
test('an ordinary ack is still an acknowledgement', async () => {
  await withRecipient((ws, ackId) => {
    ws.send(JSON.stringify({
      id: 100, type: 'channel-notification-ack', agent: 'fleet:recipient', ack_id: ackId,
    }))
  }, async (senderWs, port) => {
    await request(senderWs, 2, 'chat', {
      from: 'fleet:sender', to: 'recipient', message: 'accepted notice',
      metadata: { trace_id: 'nack-control-proof' }, _tempId: 'nack-control',
    })
    const statuses = await wakeNotifyStatuses(port, 'nack-control-proof')
    assert.deepEqual(statuses, ['wake.mcp-notify:sent', 'wake.mcp-notify:acknowledged'])
  })
})

// And the state a nack must NOT be confused with. An MCP that says nothing is
// the wedged process the deadline exists for, and it still reads that way.
test('silence is still a timeout', async () => {
  await withRecipient(() => {}, async (senderWs, port) => {
    await request(senderWs, 2, 'chat', {
      from: 'fleet:sender', to: 'recipient', message: 'ignored notice',
      metadata: { trace_id: 'nack-silence-proof' }, _tempId: 'nack-silence',
    })
    const statuses = await wakeNotifyStatuses(port, 'nack-silence-proof')
    assert.deepEqual(statuses, ['wake.mcp-notify:sent', 'wake.mcp-notify:fallback'])
  })
})
