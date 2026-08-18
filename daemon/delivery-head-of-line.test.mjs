import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DaemonDeliveryRuntime } from './delivery-runtime.mjs'
import { DaemonOutbox } from './outbox.mjs'

// A durable queue whose head cannot be acked must not starve the rest of it.
//
// On 2026-08-18 seven `source-change` envelopes whose acks the gate refused had
// been re-sent across 113 reconnects. They and the rows sent with them filled
// the in-memory `inflight` set to 112 against a batch window of 100, so every
// row `pending(100)` returned was already inflight, every one was skipped, and
// the flush sent nothing at all. 36,000 envelopes had been stranded since 15
// August -- 6,312 `agent-route`, 575 `rpc-reply`, 2,443 `jsonl-index` -- and
// every one was recorded as queued.
//
// The reason it went unnoticed for three days is the shape: below the window
// this is a percentage cost, at the window it is a full stop, and the code reads
// identically either side of that line. Only counting tells you which side you
// are on, which is why these tests count rather than assert "it flushes".

const WINDOW = 100

// `pendingOrder` is `created_at ASC, id ASC`, `created_at` is millisecond ISO
// and `id` is a random UUID — so among envelopes enqueued in the same
// millisecond the order is random. On the live daemon 38.8% of rows share a
// timestamp with another row. These tests inject a monotonic clock so they
// assert the ordering rule rather than that coincidence; the coincidence is
// reported separately and is not this fix's to make good.
function monotonicClock() {
  let n = 0
  return () => new Date(Date.UTC(2026, 0, 1) + (n++) * 1000).toISOString()
}

function harness(t, { inflightDeadlineMs = 60_000, now = () => 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-hol-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outbox = new DaemonOutbox(join(dir, 'outbox.sqlite'), { clock: monotonicClock() })
  const sent = []
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: (msg) => { sent.push(msg); return true },
    isConnected: () => true,
    isReady: () => true,
    // Refuse every source-change ack, which is the live failure: the gate
    // returns false and the row is never removed.
    ackGate: () => false,
    // A held row is released once it is older than this, which is a separate
    // mechanism from stream blocking. Default far enough out that these tests
    // exercise the blocking; the interaction gets its own test below.
    inflightDeadlineMs,
    now,
  })
  return { outbox, delivery, sent }
}

const enqueue = (delivery, type, n, tag = '') => {
  for (let i = 0; i < n; i++) delivery.send({ type, seq: `${tag}${i}` })
}

test('a pinned head does not stop unrelated traffic', (t) => {
  const { delivery, sent } = harness(t)
  // Enough stuck source-changes to fill the window on their own, which is the
  // measured condition: 112 pinned against a window of 100.
  enqueue(delivery, 'source-change', 112, 'sc')
  delivery.flushDurable()
  sent.length = 0

  enqueue(delivery, 'agent-route', 20, 'route')
  delivery.flushDurable()

  const routes = sent.filter(m => m.type === 'agent-route')
  assert.equal(routes.length, 20,
    'agent-route is behind 112 un-ackable source-changes and has no ordering relationship with them')
})

test('source-change ordering is preserved behind a pinned source-change', (t) => {
  const { delivery, sent } = harness(t)
  enqueue(delivery, 'source-change', 3, 'first')
  delivery.flushDurable()
  const firstPass = sent.filter(m => m.type === 'source-change').map(m => m.seq)
  sent.length = 0

  // These arrive later and must NOT overtake the unacked ones above.
  enqueue(delivery, 'source-change', 5, 'later')
  delivery.flushDurable()
  const overtakers = sent.filter(m => m.type === 'source-change')

  assert.deepEqual(firstPass, ['first0', 'first1', 'first2'])
  assert.equal(overtakers.length, 0,
    'a later source-change must not overtake an earlier one still awaiting its ack')
})

test('a full window of pinned rows still leaves a full send budget', (t) => {
  const { delivery, sent } = harness(t)
  // Exactly a window's worth pinned: the boundary the live daemon crossed.
  enqueue(delivery, 'source-change', WINDOW, 'sc')
  delivery.flushDurable()
  sent.length = 0

  enqueue(delivery, 'activity-event', WINDOW, 'act')
  delivery.flushDurable()

  // Before the fix, pending(WINDOW) returned WINDOW already-pinned rows and the
  // batch contained nothing sendable at all.
  assert.equal(sent.length, WINDOW,
    `expected a full budget of ${WINDOW} with exactly ${WINDOW} pinned`)
})

test('throughput never collapses to zero, however much is pinned', (t) => {
  const { delivery, sent } = harness(t)
  // Well past the window, and past it again after the first flush pins a
  // window's worth. This is the regression guard: the failure being fixed was
  // not slow, it was zero, and only a count distinguishes those.
  enqueue(delivery, 'source-change', WINDOW * 3, 'sc')
  delivery.flushDurable()
  delivery.flushDurable()
  sent.length = 0

  enqueue(delivery, 'agent-route', 50, 'route')
  delivery.flushDurable()

  const routes = sent.filter(m => m.type === 'agent-route').length
  assert.ok(routes > 0,
    `agent-route delivery stopped entirely with ${WINDOW * 3} source-changes pinned — this is the outage`)
  assert.equal(routes, 50, 'and all of them should get through, not merely some')
})

test('nothing is dropped or dead-lettered to achieve it', (t) => {
  const { outbox, delivery } = harness(t)
  enqueue(delivery, 'source-change', 112, 'sc')
  enqueue(delivery, 'agent-route', 10, 'route')
  delivery.flushDurable()

  // Stepping over is not deleting. Every source-change is still queued and
  // still in order; seven of the real ones are somebody's document edits.
  assert.equal(outbox.pendingCount(), 122, 'every envelope is still queued')
  assert.equal(outbox.deadLetterCount(), 0, 'stepping over must never dead-letter')
})

// The seam between the two mechanisms. Stream blocking holds a row back while
// it is awaiting an ack; the inflight deadline releases it once it has waited
// too long. Both were written for the same outage by different people, so the
// interaction is where a third bug would live rather than in either alone.

test('the inflight deadline still releases a held row, and blocking does not prevent it', (t) => {
  let clock = 0
  const { delivery, sent } = harness(t, { inflightDeadlineMs: 1000, now: () => clock })
  enqueue(delivery, 'source-change', 3, 'sc')

  delivery.flushDurable()
  assert.equal(sent.filter(m => m.type === 'source-change').length, 3, 'all three go out once')
  sent.length = 0

  // Still inside the deadline: held, and holding their stream.
  clock = 500
  delivery.flushDurable()
  assert.equal(sent.length, 0, 'within the deadline a held row is not re-sent')

  // Past it: the deadline wins over the block, and they are offered again.
  clock = 5000
  delivery.flushDurable()
  assert.equal(sent.filter(m => m.type === 'source-change').length, 3,
    'past the deadline the held rows are re-offered — stream blocking must not suppress that')
})

test('a held source-change does not delay other types up to its deadline', (t) => {
  let clock = 0
  const { delivery, sent } = harness(t, { inflightDeadlineMs: 60_000, now: () => clock })
  enqueue(delivery, 'source-change', WINDOW + 5, 'sc')
  delivery.flushDurable()
  sent.length = 0

  // Well inside the deadline, so the deadline release cannot be what saves us.
  clock = 100
  enqueue(delivery, 'agent-route', 10, 'route')
  delivery.flushDurable()

  assert.equal(sent.filter(m => m.type === 'agent-route').length, 10,
    'routes must flow immediately, not wait out a source-change deadline')
})
