import fs from 'fs'
import os from 'os'
import path from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DaemonOutbox } from './outbox.mjs'
import { DaemonDeliveryRuntime } from './delivery-runtime.mjs'

function tempOutbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-delivery-'))
  return new DaemonOutbox(path.join(dir, 'outbox.sqlite'))
}

function tempOutboxWithOptions(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-delivery-'))
  return new DaemonOutbox(path.join(dir, 'outbox.sqlite'), options)
}

test('durable messages enqueue offline and flush after ready', () => {
  const sent = []
  let connected = false
  let ready = false
  const outbox = tempOutbox()
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: msg => { sent.push(msg); return connected },
    isConnected: () => connected,
    isReady: () => ready,
  })

  assert.equal(runtime.send({ type: 'source-change', project: 'doc', files: [] }), true)
  assert.equal(outbox.count(), 1)
  assert.equal(sent.length, 0)

  connected = true
  ready = true
  runtime.flushDurable()

  assert.equal(sent.length, 1)
  assert.equal(outbox.count(), 1, 'message remains pending until ack')
  runtime.handleAck(sent[0].__daemon_outbox_id)
  assert.equal(outbox.count(), 0)
  runtime.dispose()
  outbox.close()
})

test('durable in-flight rows replay after reconnect until acked', () => {
  const sent = []
  const outbox = tempOutbox()
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: msg => { sent.push(msg); return true },
    isConnected: () => true,
    isReady: () => true,
  })

  runtime.send({ type: 'terminal-chat', agent_id: 'fleet:a', text: 'hello', ts: 't' })
  runtime.flushDurable()
  runtime.flushDurable()
  assert.equal(sent.length, 1, 'in-flight row is not resent before reconnect')

  runtime.noteReady()
  runtime.flushDurable()
  assert.equal(sent.length, 2, 'ready/reconnect clears in-flight and replays unacked row')
  runtime.handleAck(sent[1].__daemon_outbox_id)
  assert.equal(outbox.count(), 0)
  runtime.dispose()
  outbox.close()
})

test('404 Project not found source-change dead-letters after bounded permanent failures', () => {
  const sent = []
  const warnings = []
  const outbox = tempOutboxWithOptions({ maxAttempts: 3 })
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: msg => { sent.push(msg); return true },
    isConnected: () => true,
    isReady: () => true,
    log: { warn: msg => warnings.push(msg) },
  })

  runtime.send({ type: 'source-change', project: 'missing-doc', files: [] })
  const id = outbox.pending()[0].id

  for (let i = 1; i <= 3; i++) {
    runtime.flushDurable()
    assert.equal(sent.length, i)
    runtime.handleError(id, 'Project not found', { permanent: true })
    runtime.dispose()
  }

  assert.equal(outbox.count(), 1, 'dead-letter keeps the original row')
  assert.equal(outbox.pendingCount(), 0)
  assert.equal(outbox.deadLetterCount(), 1)
  const row = outbox.get(id)
  assert.equal(row.type, 'source-change')
  assert.equal(row.payload.project, 'missing-doc')
  assert.equal(row.attempts, 3)
  assert.equal(row.lastError, 'Project not found')
  assert.equal(row.deadLetterReason, 'Project not found')
  assert.ok(warnings.some(msg => msg.includes('dead-lettered after 3 attempts')))
  runtime.dispose()
  outbox.close()
})

test('recoverable durable send failure retries and succeeds without dead-lettering', () => {
  const sent = []
  let sendOpen = false
  const outbox = tempOutboxWithOptions({ maxAttempts: 1 })
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: msg => {
      if (!sendOpen) return false
      sent.push(msg)
      return true
    },
    isConnected: () => true,
    isReady: () => true,
  })

  runtime.send({ type: 'source-change', project: 'doc', files: [] })
  const id = outbox.pending()[0].id

  runtime.flushDurable()
  assert.equal(outbox.pendingCount(), 1)
  assert.equal(outbox.deadLetterCount(), 0, 'local send failures are transient')
  assert.equal(outbox.get(id).lastError, 'websocket not open')

  sendOpen = true
  runtime.flushDurable()
  assert.equal(sent.length, 1)
  runtime.handleAck(id)
  assert.equal(outbox.count(), 0)
  runtime.dispose()
  outbox.close()
})

test('generic 500 server delivery errors record last_error but still retry and ack', () => {
  const sent = []
  const outbox = tempOutboxWithOptions({ maxAttempts: 1 })
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: msg => { sent.push(msg); return true },
    isConnected: () => true,
    isReady: () => true,
  })

  runtime.send({ type: 'source-change', project: 'doc', files: [] })
  const id = outbox.pending()[0].id

  runtime.flushDurable()
  runtime.handleError(id, 'Internal Server Error')
  runtime.dispose()
  assert.equal(outbox.pendingCount(), 1)
  assert.equal(outbox.deadLetterCount(), 0)
  assert.equal(outbox.get(id).lastError, 'Internal Server Error')

  runtime.flushDurable()
  assert.equal(sent.length, 2)
  runtime.handleAck(id)
  assert.equal(outbox.count(), 0)
  runtime.dispose()
  outbox.close()
})

test('late server error for unknown outbox id is a harmless no-op', () => {
  const outbox = tempOutboxWithOptions({ maxAttempts: 1 })
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: () => true,
    isConnected: () => true,
    isReady: () => true,
  })

  runtime.send({ type: 'source-change', project: 'doc', files: [] })
  const id = outbox.pending()[0].id
  runtime.flushDurable()
  runtime.handleAck(id)
  assert.equal(outbox.count(), 0)

  runtime.handleError(id, 'late Project not found', { permanent: true })
  runtime.handleError('unknown-outbox-id', 'late Internal Server Error')

  assert.equal(outbox.count(), 0)
  assert.equal(outbox.pendingCount(), 0)
  assert.equal(outbox.deadLetterCount(), 0)
  runtime.dispose()
  outbox.close()
})

test('ephemeral FIFO is bounded and not persisted', () => {
  const sent = []
  const outbox = tempOutbox()
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: msg => { sent.push(msg); return false },
    isConnected: () => false,
    isReady: () => false,
    ephemeralQueueLimit: 2,
  })

  runtime.send({ type: 'terminal-data', agent_id: 'fleet:a', data: 'one' })
  runtime.send({ type: 'terminal-data', agent_id: 'fleet:a', data: 'two' })
  runtime.send({ type: 'terminal-data', agent_id: 'fleet:a', data: 'three' })

  assert.equal(outbox.count(), 0)
  assert.deepEqual([...runtime.ephemeralQueues.values()][0].map(m => m.data), ['two', 'three'])
  runtime.dispose()
  outbox.close()
})

test('latest-wins keeps only the newest queued frame', () => {
  const outbox = tempOutbox()
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: () => false,
    isConnected: () => false,
    isReady: () => false,
  })

  runtime.send({ type: 'terminal-size', agent_id: 'fleet:a', cols: 80, rows: 24 })
  runtime.send({ type: 'terminal-size', agent_id: 'fleet:a', cols: 120, rows: 40 })

  assert.equal(outbox.count(), 0)
  assert.deepEqual([...runtime.ephemeralQueues.values()][0].map(m => m.cols), [120])
  runtime.dispose()
  outbox.close()
})

test('reconnect drops queued ephemeral telemetry instead of replaying stale frames', () => {
  const sent = []
  const outbox = tempOutbox()
  const runtime = new DaemonDeliveryRuntime({
    outbox,
    send: msg => { sent.push(msg); return true },
    isConnected: () => true,
    isReady: () => true,
  })

  runtime.ephemeralQueues.set('terminal-data:fleet:a', [
    { type: 'terminal-data', agent_id: 'fleet:a', data: 'stale' },
  ])
  runtime.noteReady()
  runtime.flushEphemeral()

  assert.equal(sent.length, 0)
  assert.equal(runtime.ephemeralQueues.size, 0)
  runtime.dispose()
  outbox.close()
})
