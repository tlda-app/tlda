// A refusal is an answer, and an answer settles the delivery.
//
// `handleAck` declines to settle a source-change whose ackGate is closed. The
// gate reads a disposition that a refused push does not always produce, so a
// refused row was re-offered on every inflight deadline, re-sent, refused
// again, and never removed.
//
// Measured on bregman at 13:39:25Z: 35 pending source-change rows, oldest from
// 09:36:54Z, ~105 attempts each, and `last_error: null` on all of them -- the
// outbox had never recorded that the server said anything, which is why the
// deadline warning read "the server received it and never answered" while the
// server had answered roughly thirty-five hundred times.
//
// The bytes are not at risk here and that is what makes settling safe: by the
// time this runs the sync layer has already enqueued the retry, or blocked the
// project with the payload held in `blockedPayloads`, or handed the conflict to
// a person via holdForHuman. What leaves the queue is a finished delivery, not
// an unresolved edit.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DaemonDeliveryRuntime } from './delivery-runtime.mjs'

const DEADLINE_MS = 120_000
const ROW = { id: 'refused-source-change', type: 'source-change', payload: { type: 'source-change' }, attempts: 105 }

function fakeOutbox(rows) {
  const store = rows.map(r => ({ ...r }))
  return {
    rows: store,
    pending: (limit = 100) => store.filter(r => !r.acked).slice(0, limit),
    // The claim step the flush actually uses: same window and order, ids and
    // types only. A double that served payloads here would hide the whole point
    // of the change -- the flush must decide skips without reading them.
    pendingRefs: (limit = 100) => store.filter(r => !r.acked).slice(0, limit)
      .map(r => ({ id: r.id, type: r.payload?.type || r.type || '' })),
    pendingRefsExcludingTypes: (types = [], limit = 100) => {
      const skip = new Set(types)
      return store.filter(r => !r.acked && !skip.has(r.payload?.type || r.type || ''))
        .slice(0, limit).map(r => ({ id: r.id, type: r.payload?.type || r.type || '' }))
    },
    getWithSize: id => {
      const r = store.find(x => x.id === id && !x.acked) || store.find(x => x.id === id)
      if (!r || r.acked) return null
      return { ...r, payloadBytes: JSON.stringify(r.payload ?? null).length }
    },
    markAttempt: id => { const r = store.find(x => x.id === id); if (r) r.attempts = (r.attempts || 0) + 1 },
    markTransientError: () => {},
    markError: () => {},
    deadLetter: () => {},
    ack: id => { const r = store.find(x => x.id === id); if (r) r.acked = true },
    get: id => store.find(x => x.id === id && !x.acked) || null,
    enqueue: () => {},
  }
}

/** A runtime whose ackGate is permanently closed — the state that pinned him. */
function runtimeWithClosedGate(rows = [ROW]) {
  const warnings = []
  const outbox = fakeOutbox(rows)
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: () => true,
    isConnected: () => true,
    isReady: () => true,
    log: { warn: m => warnings.push(m) },
    ackGate: () => false,
    inflightDeadlineMs: DEADLINE_MS,
    flushByteBudget: 1_048_576,
  })
  return { delivery, outbox, warnings }
}

test('the gate still refuses an ack — the behaviour this does not change', () => {
  const { delivery, outbox } = runtimeWithClosedGate()
  assert.equal(delivery.handleAck(ROW.id), false)
  assert.ok(outbox.get(ROW.id), 'an unanswered push must not disappear while its edits are unresolved')
})

test('a refusal settles the row the gate would not', () => {
  const { delivery, outbox } = runtimeWithClosedGate()
  assert.equal(delivery.settleRefused(ROW.id, 'stale-base'), true)
  assert.equal(outbox.get(ROW.id), null, 'the row must leave the queue')
})

test('settling says why, and how many attempts it took', () => {
  // A row that leaves without a trace is the same disease as one that never
  // leaves. The attempt count is what makes an old pin visible after the fact.
  const { delivery, warnings } = runtimeWithClosedGate()
  delivery.settleRefused(ROW.id, 'stale-base')
  assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`)
  assert.match(warnings[0], /settled by refusal/)
  assert.match(warnings[0], /105 attempt/)
  assert.match(warnings[0], /stale-base/)
  assert.match(warnings[0], /sync layer owns/)
})

test('a settled row is not re-offered on the next flush', () => {
  // The whole symptom: ~105 re-offers of the same payload over four hours.
  const sent = []
  const outbox = fakeOutbox([ROW])
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: message => { sent.push(message); return true },
    isConnected: () => true,
    isReady: () => true,
    ackGate: () => false,
    inflightDeadlineMs: DEADLINE_MS,
    flushByteBudget: 1_048_576,
  })

  delivery.flushDurable()
  assert.equal(sent.length, 1)

  delivery.settleRefused(ROW.id, 'stale-base')
  delivery.flushDurable()
  assert.equal(sent.length, 1, 'a settled refusal must not be sent again')
  assert.deepEqual(outbox.pending(), [])
})

test('settling an unknown row is a no-op rather than a phantom warning', () => {
  const { delivery, warnings } = runtimeWithClosedGate()
  assert.equal(delivery.settleRefused('no-such-row', 'stale-base'), false)
  assert.equal(delivery.settleRefused(null, 'stale-base'), false)
  assert.deepEqual(warnings, [])
})

// The wire, not the two ends. A refusal must settle by deliveryId, because that
// is the only identifier both sides still agree on after a reconnect:
// `handleSourceChangeResult` returns early for a requestId with no pending
// entry, `beginReconnect()` clears `pending` wholesale, and the server's replay
// branch answers with the STORED operation's requestId rather than the live
// one. Keyed on the request, this fix would be inert on exactly the long-lived
// rows it exists for — which is indistinguishable from not being needed.
test('a refusal settles by deliveryId with no correlation state at all', () => {
  const outbox = fakeOutbox([ROW])
  const warnings = []
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: () => true,
    isConnected: () => true,
    isReady: () => true,
    log: { warn: m => warnings.push(m) },
    ackGate: () => false,
    inflightDeadlineMs: DEADLINE_MS,
    flushByteBudget: 1_048_576,
  })

  // Exactly what the daemon does on a terminal result, with no pending map,
  // no requestId lookup and nothing else in scope.
  const msg = { type: 'source-change-result', ok: false, deliveryId: ROW.id, status: 'stale-base', requestId: 'a-request-id-nobody-holds' }
  if (msg.ok === false && msg.deliveryId) delivery.settleRefused(msg.deliveryId, msg.error || msg.status)

  assert.equal(outbox.get(ROW.id), null, 'the row must settle on a reply whose requestId is unknown')
  assert.match(warnings[0], /stale-base/)
})
