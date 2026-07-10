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
