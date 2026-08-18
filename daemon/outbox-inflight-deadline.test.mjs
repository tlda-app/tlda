// No single message may pin the head of the daemon's only delivery queue.
//
// `inflight` stops a row being sent twice in one flush pass. It was cleared by
// an ack, an error, a failed send, or a reconnect -- and by nothing else. So a
// message the server RECEIVED and never answered stayed in it forever, was
// skipped on every pass, and kept its slot in the 100-row FIFO window.
//
// On 2026-08-18 that happened to seven rejected bregman source-changes, ~325 KB
// each. They pinned the head of the outbox for 22 minutes; 1,496 messages
// backed up behind them, 387 of them activity events, and Skip's activity cards
// arrived up to seven minutes late. He reported it as "why are activity cards
// fucking brokeb" -- the cards were correct and painting in 6-22ms.
//
// The reason nobody had caught it: noteReady() clears inflight on reconnect, and
// the daemon's socket flapped often enough to keep unpinning the queue. The
// reconnect was hiding the bug it was also causing.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DaemonDeliveryRuntime } from './delivery-runtime.mjs'

const DEADLINE_MS = 120_000

/** Minimal outbox: FIFO by insertion, which is what pending(100) gives. */
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
    deadLetter: () => {},
    ack: id => { const r = store.find(x => x.id === id); if (r) r.acked = true },
    get: id => store.find(x => x.id === id) || null,
    enqueue: () => {},
  }
}

function runtimeOver(rows, { clock }) {
  const sent = []
  const warnings = []
  const delivery = new DaemonDeliveryRuntime({
    outbox: fakeOutbox(rows),
    send: message => { sent.push(message); return true },
    isConnected: () => true,
    isReady: () => true,
    log: { warn: m => warnings.push(m) },
    inflightDeadlineMs: DEADLINE_MS,
    flushByteBudget: 1_048_576,
    now: () => clock.ms,
  })
  return { delivery, sent, warnings }
}

const HEAD = { id: 'stuck-source-change', payload: { type: 'source-change' } }
const BEHIND = { id: 'activity-1', payload: { type: 'activity-event' } }

test('an unanswered head is skipped while it is still plausibly in flight', () => {
  const clock = { ms: 1_000_000 }
  const { delivery, sent } = runtimeOver([HEAD, BEHIND], { clock })

  delivery.flushDurable()
  assert.deepEqual(sent.map(m => m.type), ['source-change', 'activity-event'])

  // Neither acked. A second pass inside the deadline must not resend either:
  // that is what inflight is for.
  clock.ms += 30_000
  delivery.flushDurable()
  assert.equal(sent.length, 2, 'nothing should be resent inside the deadline')
})

test('past the deadline the head releases its slot and is offered again', () => {
  const clock = { ms: 1_000_000 }
  const { delivery, sent, warnings } = runtimeOver([HEAD, BEHIND], { clock })

  delivery.flushDurable()
  clock.ms += DEADLINE_MS + 1
  delivery.flushDurable()

  assert.deepEqual(sent.map(m => m.type),
    ['source-change', 'activity-event', 'source-change', 'activity-event'])
  assert.ok(warnings.some(w => /unanswered for \d+s/.test(w)),
    `expiry must be loud, got ${JSON.stringify(warnings)}`)
  assert.ok(warnings.some(w => /never answered/.test(w)),
    'the warning must say the server never answered, not just that time passed')
})

test('the queue keeps moving even when the head is never answered at all', () => {
  // The property that matters. The head here is answered by nobody, ever --
  // exactly the rejected source-change. Everything behind it must still flow.
  const clock = { ms: 1_000_000 }
  const rows = [HEAD, ...Array.from({ length: 5 }, (_, i) => ({ id: `activity-${i}`, payload: { type: 'activity-event' } }))]
  const { delivery, sent } = runtimeOver(rows, { clock })

  for (let pass = 0; pass < 4; pass++) {
    delivery.flushDurable()
    clock.ms += DEADLINE_MS + 1
  }

  const activitySends = sent.filter(m => m.type === 'activity-event').length
  assert.equal(activitySends, 20, 'every activity row should be offered on every pass')
})

test('an acked row leaves inflight and stops being sent', () => {
  const clock = { ms: 1_000_000 }
  const outbox = fakeOutbox([HEAD, BEHIND])
  const sent = []
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: message => { sent.push(message); return true },
    isConnected: () => true,
    isReady: () => true,
    inflightDeadlineMs: DEADLINE_MS,
    flushByteBudget: 1_048_576,
    now: () => clock.ms,
  })

  delivery.flushDurable()
  delivery.handleAck('activity-1')
  clock.ms += DEADLINE_MS + 1
  delivery.flushDurable()

  assert.equal(sent.filter(m => m.type === 'activity-event').length, 1,
    'an acked row must not be re-sent after the deadline')
})

test('the deadline is required — a runtime built without one is a pin waiting to happen', () => {
  assert.throws(() => new DaemonDeliveryRuntime({
    outbox: fakeOutbox([]),
    send: () => true,
    isConnected: () => true,
    isReady: () => true,
  }), /positive inflightDeadlineMs/)
})
