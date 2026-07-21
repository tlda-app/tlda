import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DaemonDeliveryRuntime } from '../daemon/delivery-runtime.mjs'
import { daemonDeliveryPolicy, DELIVERY_DURABLE_FIFO } from '../daemon/delivery-policy.mjs'
import { createMachineRpc, rpcRequestFingerprint } from '../daemon/machine-rpc.mjs'
import { DaemonOutbox } from '../daemon/outbox.mjs'
import { startWsRequest } from '../shared/fleet-transport.mjs'

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-rpc-reconnect-'))
  const outbox = new DaemonOutbox(join(dir, 'outbox.sqlite'))
  const sent = []
  let connected = true
  let ready = true
  let receiver = () => {}
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: message => {
      if (!connected) return false
      sent.push(message)
      receiver(message)
      return true
    },
    isConnected: () => connected,
    isReady: () => ready,
  })
  t.after(() => {
    delivery.dispose()
    outbox.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    delivery,
    outbox,
    sent,
    setReceiver(fn) { receiver = fn },
    disconnect() { connected = false; ready = false },
    reconnect() { connected = true; ready = true; delivery.noteReady(); delivery.flushDurable() },
  }
}

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('rpc replies are durable and canonical fingerprints ignore object key order', () => {
  assert.equal(daemonDeliveryPolicy({ type: 'rpc-reply', id: 'r1' }), DELIVERY_DURABLE_FIFO)
  assert.equal(
    rpcRequestFingerprint({ type: 'rpc', id: 'a', op: 'send-text', body: { a: 1, b: 2 } }),
    rpcRequestFingerprint({ type: 'rpc', id: 'b', op: 'send-text', body: { b: 2, a: 1 } }),
  )
})

test('closed socket after execution replays reply on daemon-ready and resolves server request', async t => {
  const h = harness(t)
  const pending = new Map()
  const serverPromise = startWsRequest({
    pending,
    id: 'stable-reconnect',
    type: 'rpc:send-text',
    deadlineMs: 100,
    send: () => true,
  })
  h.setReceiver(reply => {
    const entry = pending.get(reply.id)
    if (reply.error) entry?.reject(new Error(reply.error))
    else entry?.resolve(reply.result)
  })
  let executions = 0
  const rpc = createMachineRpc({ sendMsg: message => h.delivery.send(message) })
  rpc.register({
    'send-text': async () => {
      executions++
      h.disconnect()
      return { ok: true }
    },
  })

  await rpc.handleRpc({ type: 'rpc', id: 'stable-reconnect', op: 'send-text', text: 'hello' })
  assert.equal(executions, 1)
  assert.equal(h.sent.length, 0)
  assert.equal(h.outbox.pendingCount(), 1)
  h.reconnect()
  assert.deepEqual(await serverPromise, { ok: true })
  assert.equal(h.sent.at(-1).id, 'stable-reconnect')
})

test('bounded admission rejects overflow while preserving in-flight same-id replay', async t => {
  const h = harness(t)
  const firstGate = deferred()
  const secondGate = deferred()
  let executions = 0
  const rpc = createMachineRpc({
    sendMsg: message => h.delivery.send(message),
    replayLimit: 2,
  })
  rpc.register({
    blocked: async msg => {
      executions++
      await (msg.slot === 1 ? firstGate.promise : secondGate.promise)
      return { slot: msg.slot }
    },
  })

  const first = rpc.handleRpc({ type: 'rpc', id: 'one', op: 'blocked', slot: 1 })
  const second = rpc.handleRpc({ type: 'rpc', id: 'two', op: 'blocked', slot: 2 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(executions, 2)

  await rpc.handleRpc({ type: 'rpc', id: 'overflow', op: 'blocked', slot: 3 })
  h.delivery.flushDurable()
  assert.match(h.sent.at(-1).error, /capacity reached/)
  assert.equal(executions, 2, 'overflow must not execute')

  const duplicate = rpc.handleRpc({ type: 'rpc', id: 'one', op: 'blocked', slot: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(executions, 2, 'duplicate in-flight id must share execution')
  firstGate.resolve()
  secondGate.resolve()
  await Promise.all([first, second, duplicate])
  assert.equal(executions, 2)
})

test('settled replay entries are evicted before applying admission backpressure', async t => {
  const h = harness(t)
  let executions = 0
  const rpc = createMachineRpc({ sendMsg: message => h.delivery.send(message), replayLimit: 1 })
  rpc.register({ run: async msg => ({ value: msg.value, execution: ++executions }) })
  await rpc.handleRpc({ type: 'rpc', id: 'settled-one', op: 'run', value: 1 })
  await rpc.handleRpc({ type: 'rpc', id: 'settled-two', op: 'run', value: 2 })
  assert.equal(executions, 2)
  h.delivery.flushDurable()
  assert.deepEqual(h.sent.at(-1).result, { value: 2, execution: 2 })
})

test('same id with a different operation or payload is rejected without execution', async t => {
  const h = harness(t)
  let executions = 0
  const rpc = createMachineRpc({ sendMsg: message => h.delivery.send(message) })
  rpc.register({
    alpha: async () => ({ execution: ++executions }),
    beta: async () => ({ execution: ++executions }),
  })

  await rpc.handleRpc({ type: 'rpc', id: 'bound', op: 'alpha', value: 1 })
  h.delivery.flushDurable()
  assert.equal(executions, 1)
  await rpc.handleRpc({ type: 'rpc', id: 'bound', op: 'beta', value: 1 })
  h.delivery.flushDurable()
  assert.match(h.sent.at(-1).error, /different operation or payload/)
  await rpc.handleRpc({ type: 'rpc', id: 'bound', op: 'alpha', value: 2 })
  h.delivery.flushDurable()
  assert.match(h.sent.at(-1).error, /different operation or payload/)
  assert.equal(executions, 1)
})

test('timeout rejects honestly; late durable reply and same-id retry never repeat execution', async t => {
  const h = harness(t)
  const pending = new Map()
  const serverPromise = startWsRequest({
    pending,
    id: 'late',
    type: 'rpc:check-alive',
    deadlineMs: 5,
    makeDeadlineError: () => new Error('RPC timeout after 5ms'),
    send: () => true,
  })
  h.setReceiver(reply => pending.get(reply.id)?.resolve(reply.result))
  let executions = 0
  const rpc = createMachineRpc({ sendMsg: message => h.delivery.send(message) })
  rpc.register({
    'check-alive': async () => {
      executions++
      h.disconnect()
      return { alive: true }
    },
  })

  const request = { type: 'rpc', id: 'late', op: 'check-alive', agent_id: 'fleet:x' }
  await rpc.handleRpc(request)
  await assert.rejects(serverPromise, /RPC timeout after 5ms/)
  h.reconnect()
  assert.equal(pending.size, 0)
  await rpc.handleRpc(request)
  assert.equal(executions, 1)
})
