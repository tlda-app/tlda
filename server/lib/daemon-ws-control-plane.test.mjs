import test from 'node:test'
import assert from 'node:assert/strict'
import { createDaemonWsControlPlane } from './daemon-ws-control-plane.mjs'

function fixture(overrides = {}) {
  const sent = []
  const diags = []
  const calls = []
  let clock = 1000
  const processed = new Set()
  const plane = createDaemonWsControlPlane({
    daemonConnections: new Map(),
    serverDaemonOutboxInflight: new Map(),
    fleetStore: {
      daemonOutboxWasProcessed: async (id) => (calls.push(['wasProcessed', id]), processed.has(id)),
      markDaemonOutboxProcessed: async (id, type) => (calls.push(['markProcessed', id, type]), processed.add(id)),
      serverDaemonOutboxAck: async () => {},
      serverDaemonOutboxGet: async () => null,
      serverDaemonOutboxMarkError: async () => {},
    },
    performanceNow: () => clock,
    onDispatchDiag: (diag) => diags.push(diag),
    ...overrides,
  })
  const ws = { readyState: 1, send: (value) => sent.push(JSON.parse(value)) }
  return { plane, ws, sent, diags, calls, advance: (ms) => { clock += ms } }
}

const HANDLER = async () => {}

test('processed envelope records type, outbox id, handler and mark durations, then ACKs', async () => {
  const f = fixture()
  let handlerSaw
  f.advance(0)
  const receivedAt = 1000
  const result = await f.plane.handleDaemonOutboxEnvelope(
    f.ws,
    { type: 'activity-event', __daemon_outbox_id: 'D-1' },
    async () => { handlerSaw = 1000; f.advance(30) },
    { queueWaitMs: 12.5 },
  )
  f.advance(7)
  assert.equal(result.kind, 'processed')
  assert.deepEqual(f.sent, [{ type: 'daemon-outbox-ack', outbox_id: 'D-1' }])
  assert.equal(handlerSaw, 1000)
  assert.deepEqual(f.calls.map((c) => c[0]), ['wasProcessed', 'markProcessed'])
  assert.equal(f.diags.length, 1)
  const [diag] = f.diags
  assert.equal(diag.type, 'activity-event')
  assert.equal(diag.outboxId, 'D-1')
  assert.equal(diag.kind, 'processed')
  assert.equal(diag.queueWaitMs, 12.5)
  assert.equal(diag.handlerMs, 30)
  // mark duration is measured too (0 here: no clock advance inside the mark)
  assert.equal(diag.markProcessedMs, 0)
  assert.equal(diag.error, undefined)
})

test('mark duration is measured separately from handler duration', async () => {
  const f = fixture({
    fleetStore: {
      daemonOutboxWasProcessed: async () => false,
      markDaemonOutboxProcessed: async () => { f.advance(45) },
      serverDaemonOutboxAck: async () => {},
    },
  })
  await f.plane.handleDaemonOutboxEnvelope(
    f.ws, { type: 'activity-event', __daemon_outbox_id: 'D-2' }, async () => { f.advance(5) }, {},
  )
  assert.equal(f.diags.length, 1)
  assert.equal(f.diags[0].handlerMs, 5)
  assert.equal(f.diags[0].markProcessedMs, 45)
})

test('duplicate redelivery skips the handler, still ACKs, still records a diag', async () => {
  const f = fixture()
  let handlerCalls = 0
  await f.plane.handleDaemonOutboxEnvelope(
    f.ws, { type: 'activity-event', __daemon_outbox_id: 'D-3' }, HANDLER, { queueWaitMs: 9000 },
  )
  await f.plane.handleDaemonOutboxEnvelope(
    f.ws, { type: 'activity-event', __daemon_outbox_id: 'D-3' }, async () => { handlerCalls += 1 }, { queueWaitMs: 9000 },
  )
  assert.equal(handlerCalls, 0)
  assert.deepEqual(f.sent, [
    { type: 'daemon-outbox-ack', outbox_id: 'D-3' },
    { type: 'daemon-outbox-ack', outbox_id: 'D-3' },
  ])
  assert.deepEqual(f.diags.map((d) => d.kind), ['processed', 'duplicate-daemon-outbox'])
  assert.equal(f.diags[1].outboxId, 'D-3')
  assert.equal(f.diags[1].queueWaitMs, 9000)
})

test('handler error sends an error frame (not an ACK) and records the error diag', async () => {
  const f = fixture()
  const errors = []
  const result = await f.plane.handleDaemonOutboxEnvelope(
    f.ws,
    { type: 'activity-event', __daemon_outbox_id: 'D-4' },
    async () => { throw new Error('store blew up') },
    { queueWaitMs: 3, onHandlerError: (e) => errors.push(e) },
  )
  assert.equal(result.kind, 'error')
  assert.equal(errors.length, 1)
  assert.deepEqual(f.sent, [{
    type: 'daemon-outbox-error', outbox_id: 'D-4', error: 'store blew up', permanent: false,
  }])
  assert.equal(f.diags.length, 1)
  assert.equal(f.diags[0].kind, 'error')
  assert.equal(f.diags[0].outboxId, 'D-4')
  assert.equal(f.diags[0].error, 'store blew up')
})

test('envelope without an outbox id is handled with a null outboxId and no ACK', async () => {
  const f = fixture()
  let handled = 0
  const result = await f.plane.handleDaemonOutboxEnvelope(
    f.ws, { type: 'daemon-hello' }, async () => { handled += 1 }, {},
  )
  assert.equal(result.kind, 'processed')
  assert.equal(handled, 1)
  assert.deepEqual(f.sent, [])
  assert.equal(f.diags.length, 1)
  assert.equal(f.diags[0].outboxId, null)
  assert.equal(f.diags[0].type, 'daemon-hello')
})

test('diagnostics are optional: no hook, no behavior change', async () => {
  const f = fixture({ onDispatchDiag: null })
  const result = await f.plane.handleDaemonOutboxEnvelope(
    f.ws, { type: 'activity-event', __daemon_outbox_id: 'D-5' }, HANDLER, {},
  )
  assert.equal(result.kind, 'processed')
  assert.deepEqual(f.sent, [{ type: 'daemon-outbox-ack', outbox_id: 'D-5' }])
  assert.deepEqual(f.diags, [])
})

test('serial dispatch preserves per-envelope order and diags follow suit', async () => {
  const f = fixture()
  let chain = Promise.resolve()
  const kinds = []
  for (const id of ['D-a', 'D-b', 'D-c']) {
    chain = chain.then(() => f.plane.handleDaemonOutboxEnvelope(
      f.ws, { type: 'activity-event', __daemon_outbox_id: id }, HANDLER, { queueWaitMs: 1 },
    ).then((r) => kinds.push(r.kind)))
  }
  await chain
  assert.deepEqual(kinds, ['processed', 'processed', 'processed'])
  assert.deepEqual(f.diags.map((d) => d.outboxId), ['D-a', 'D-b', 'D-c'])
  assert.deepEqual(f.sent.map((m) => m.outbox_id), ['D-a', 'D-b', 'D-c'])
})
