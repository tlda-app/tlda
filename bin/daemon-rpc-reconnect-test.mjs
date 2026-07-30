import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import { DaemonDeliveryRuntime } from '../daemon/delivery-runtime.mjs'
import { daemonDeliveryPolicy, DELIVERY_DURABLE_FIFO, DELIVERY_LATEST_WINS } from '../daemon/delivery-policy.mjs'
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
  assert.equal(daemonDeliveryPolicy({ type: 'agent-route' }), DELIVERY_DURABLE_FIFO)
  assert.equal(
    rpcRequestFingerprint({ type: 'rpc', id: 'a', op: 'send-text', body: { a: 1, b: 2 } }),
    rpcRequestFingerprint({ type: 'rpc', id: 'b', op: 'send-text', body: { b: 2, a: 1 } }),
  )
})

test('agent routes are durable and replay after reconnect', t => {
  const h = harness(t)
  h.disconnect()

  assert.equal(h.delivery.send({
    type: 'agent-route',
    agent_id: 'fleet:seat',
    daemon_key: 'mini:testing',
  }), true)
  assert.equal(h.sent.length, 0)
  assert.equal(h.outbox.pendingCount(), 1)

  h.reconnect()

  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].type, 'agent-route')
  assert.equal(h.sent[0].agent_id, 'fleet:seat')
  assert.ok(h.sent[0].__daemon_outbox_id)
})

test('liveness survives a reconnect as a latest-wins message', t => {
  const h = harness(t)
  h.disconnect()

  assert.equal(daemonDeliveryPolicy({ type: 'agent-liveness' }), DELIVERY_LATEST_WINS)

  assert.equal(h.delivery.send({ type: 'agent-liveness', agent_ids: ['fleet:a'], checked_agent_ids: ['fleet:a'], ts: '2026-07-21T23:00:00.000Z' }), false)
  assert.equal(h.delivery.send({ type: 'agent-liveness', agent_ids: ['fleet:b'], checked_agent_ids: ['fleet:b'], ts: '2026-07-21T23:00:01.000Z' }), false)
  assert.equal(h.sent.length, 0)

  h.reconnect()
  h.delivery.flushEphemeral()

  assert.deepEqual(h.sent.map(m => m.type), ['agent-liveness'])
  assert.deepEqual(h.sent[0].agent_ids, ['fleet:b'])
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

test('restart recovery replays only exact C-End and shares duplicate execution', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-rpc-recovery-'))
  const dbPath = join(dir, 'executions.sqlite')
  const seed = new Database(dbPath)
  seed.exec(`
    CREATE TABLE daemon_rpc_executions (
      request_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'terminal')),
      reply TEXT,
      updated_at INTEGER NOT NULL
    )
  `)
  const requests = [
    { type: 'rpc', id: 'safe', op: 'send-key', agent_id: 'fleet:x', key: 'C-End' },
    { type: 'rpc', id: 'unsafe', op: 'send-key', agent_id: 'fleet:x', key: 'Enter' },
    { type: 'rpc', id: 'mismatch', op: 'send-key', agent_id: 'fleet:x', key: 'C-End' },
  ]
  const insert = seed.prepare(`
    INSERT INTO daemon_rpc_executions
      (request_id, operation, fingerprint, status, reply, updated_at)
    VALUES (?, ?, ?, 'running', NULL, ?)
  `)
  for (const request of requests) {
    insert.run(request.id, request.op, rpcRequestFingerprint(request), request.id === 'unsafe' ? 0 : Date.now())
  }
  seed.close()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const sent = []
  const gate = deferred()
  let safeExecutions = 0
  let unsafeExecutions = 0
  const rpc = createMachineRpc({ sendMsg: message => sent.push(message), executionDbPath: dbPath })
  rpc.register({
    'send-key': async msg => {
      if (msg.key === 'C-End') {
        safeExecutions++
        await gate.promise
      } else {
        unsafeExecutions++
      }
      return { ok: true }
    },
  })

  const safeFirst = rpc.handleRpc(requests[0])
  const safeDuplicate = rpc.handleRpc(requests[0])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(safeExecutions, 1)
  gate.resolve()
  await Promise.all([safeFirst, safeDuplicate])
  assert.equal(sent.filter(reply => reply.id === 'safe').length, 2)
  assert.deepEqual(sent.filter(reply => reply.id === 'safe').map(reply => reply.result), [{ ok: true }, { ok: true }])

  await rpc.handleRpc(requests[1])
  assert.equal(unsafeExecutions, 0)
  assert.equal(sent.at(-1).reason, 'indeterminate-after-restart')

  await rpc.handleRpc({ ...requests[2], agent_id: 'fleet:other' })
  assert.equal(safeExecutions, 1)
  assert.match(sent.at(-1).error, /different operation or payload/)
})
