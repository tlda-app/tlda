// The daemon is a relay as well as a queue, and the queue must not be able to
// stop the relay answering.
//
// This is not the pin in outbox-inflight-deadline.test.mjs (a row keeping its
// slot forever), nor the one in delivery-head-of-line.test.mjs (one blocked
// stream stalling every other). It is the cost of *looking* at the window:
// flushDurable read its rows with payloads and decided afterwards which to skip,
// so every skipped row was fetched from SQLite and JSON.parse'd for nothing.
//
// Measured on the live testing daemon 2026-08-18: one 100-row window was 11.0 MB,
// 10.9 MB of it a single source-change payload, at 270-702ms of synchronous time
// per flush. Delivery had a ceiling of 84 rows/min against 104 produced -- the
// queue grew because the ceiling sat below production, not because nothing was
// being acknowledged.
//
// The fix is the ordinary claim step of a leased queue: claim ids without
// bodies, read only what you are about to send, bound the batch by bytes.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DaemonDeliveryRuntime } from './delivery-runtime.mjs'

const DEADLINE_MS = 120_000

/**
 * Outbox double that records what the flush actually read. `payloadReads` is the
 * measurement this file exists for: it counts payload fetches, which is the work
 * that pinned the loop.
 */
function countingOutbox(rows) {
  const store = rows.map(r => ({ ...r }))
  const counts = { refScans: 0, refLimits: [], claimedRefs: 0, payloadReads: 0 }
  const live = () => store.filter(r => !r.acked)
  const ref = r => ({ id: r.id, type: r.payload?.type || '' })
  return {
    counts,
    pendingRefs: (limit = 100) => {
      counts.refScans++
      counts.refLimits.push(limit)
      const rows = live().slice(0, limit).map(ref)
      counts.claimedRefs += rows.length
      return rows
    },
    pendingRefsExcludingTypes: (types = [], limit = 100) => {
      counts.refScans++
      const skip = new Set(types)
      const rows = live().filter(r => !skip.has(r.payload?.type || '')).slice(0, limit).map(ref)
      counts.claimedRefs += rows.length
      return rows
    },
    pendingRefsOfTypes: (types = [], limit = 100) => {
      counts.refScans++
      counts.refLimits.push(limit)
      const include = new Set(types)
      const rows = live().filter(r => include.has(r.payload?.type || '')).slice(0, limit).map(ref)
      counts.claimedRefs += rows.length
      return rows
    },
    getWithSize: id => {
      counts.payloadReads++
      const r = store.find(x => x.id === id)
      return r ? { ...r, payloadBytes: r.payloadBytes } : null
    },
    markAttempt: () => {},
    markTransientError: () => {},
    deadLetter: () => {},
    ack: id => { const r = store.find(x => x.id === id); if (r) r.acked = true },
    get: id => store.find(x => x.id === id) || null,
    enqueue: () => {},
  }
}

function runtimeOver(rows, { clock, flushByteBudget }) {
  const outbox = countingOutbox(rows)
  const sent = []
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: message => { sent.push(message); return true },
    isConnected: () => true,
    isReady: () => true,
    inflightDeadlineMs: DEADLINE_MS,
    flushByteBudget,
    now: () => clock.ms,
  })
  return { delivery, sent, outbox }
}

const row = (id, type, payloadBytes) => ({ id, payload: { type, id }, payloadBytes })

test('a window that is entirely in flight costs no payload reads at all', () => {
  // The lock-up, as a property. Everything has been sent and nothing answered,
  // so the next tick has nothing to do -- and must therefore do nothing.
  const clock = { ms: 1_000_000 }
  const rows = Array.from({ length: 20 }, (_, i) => row(`r${i}`, 'activity-event', 1_000))
  const { delivery, outbox, sent } = runtimeOver(rows, { clock, flushByteBudget: 1_048_576 })

  delivery.flushDurable()
  assert.equal(sent.length, 20)
  const readsAfterFirstPass = outbox.counts.payloadReads

  clock.ms += 30_000            // still inside the deadline: all 20 are in flight
  delivery.flushDurable()

  assert.equal(sent.length, 20, 'nothing should be resent inside the deadline')
  assert.equal(outbox.counts.payloadReads, readsAfterFirstPass,
    'a tick that sends nothing must read no payloads — this is the pin')
  assert.ok(outbox.counts.refScans >= 2, 'it should still have looked at the window')
})

test('a large same-type queue cannot all become inflight ahead of its acknowledgements', () => {
  const clock = { ms: 1_000_000 }
  const rows = Array.from({ length: 13_500 }, (_, i) => row(`r${i}`, 'activity-event', 100))
  const { delivery, outbox, sent } = runtimeOver(rows, { clock, flushByteBudget: 1_048_576 })

  delivery.flushDurable()
  assert.equal(sent.length, 100, 'only one receiver-sized window may await acknowledgement')

  const claimsAtCapacity = outbox.counts.claimedRefs
  delivery.flushDurable()
  assert.equal(sent.length, 100, 'a second flush without acknowledgements must send nothing')
  assert.equal(outbox.counts.claimedRefs, claimsAtCapacity,
    'at capacity it must not claim past the outstanding lane')
  assert.ok(Math.max(...outbox.counts.refLimits) <= 200,
    'the claim query must stay bounded independently of total queue depth')
})

test('one oversized payload cannot take the whole tick with it', () => {
  // 10.9 MB is not hypothetical: it is the row that sat on the head of the live
  // outbox.
  const clock = { ms: 1_000_000 }
  const rows = [
    row('huge', 'source-change', 10_900_000),
    row('a', 'activity-event', 1_000),
    row('b', 'activity-event', 1_000),
  ]
  const { delivery, sent, outbox } = runtimeOver(rows, { clock, flushByteBudget: 1_048_576 })

  delivery.flushDurable()

  assert.deepEqual(sent.map(m => m.id), ['huge'],
    'the oversized row goes alone; the budget stops the tick after it')
  assert.equal(outbox.counts.payloadReads, 1,
    'the rows it did not send must not have been read')
})

test('the bound is on bytes, not on being a source-change', () => {
  // The oversized rows tonight were source-change, and that path is being
  // deleted -- so the symptom will improve on its own and could be mistaken for
  // this fix. There is no type test in the flush; this asserts that rather than
  // trusting it.
  const clock = { ms: 1_000_000 }
  const rows = [row('huge-activity', 'activity-event', 10_900_000), row('a', 'jsonl-index', 1_000)]
  const { delivery, sent, outbox } = runtimeOver(rows, { clock, flushByteBudget: 1_048_576 })

  delivery.flushDurable()

  assert.deepEqual(sent.map(m => m.id), ['huge-activity'])
  assert.equal(outbox.counts.payloadReads, 1)
})

test('a payload larger than the entire budget is still delivered', () => {
  // A budget that could starve a big message forever would be data loss wearing
  // the costume of a fix. It is consulted between rows, never before the first.
  const clock = { ms: 1_000_000 }
  const { delivery, sent } = runtimeOver([row('huge', 'source-change', 10_900_000)],
    { clock, flushByteBudget: 1_024 })

  delivery.flushDurable()
  assert.deepEqual(sent.map(m => m.id), ['huge'], 'an oversized row must not be stuck forever')
})

test('the budget is spent across ticks, not dropped', () => {
  // Bounding the tick must not bound the queue.
  const clock = { ms: 1_000_000 }
  const rows = Array.from({ length: 4 }, (_, i) => row(`r${i}`, 'activity-event', 400_000))
  const { delivery, sent } = runtimeOver(rows, { clock, flushByteBudget: 1_048_576 })

  delivery.flushDurable()
  assert.ok(sent.length < 4, `the budget should have stopped the first pass, sent ${sent.length}`)

  for (let pass = 0; pass < 4 && sent.length < 4; pass++) delivery.flushDurable()

  assert.deepEqual(sent.map(m => m.id).sort(), ['r0', 'r1', 'r2', 'r3'],
    'every row must still be delivered, just across more than one tick')
})

test('rows skipped for a blocked ordering stream are not read either', () => {
  // The second query exists so a blocked stream's own backlog cannot fill the
  // window (delivery-head-of-line.test.mjs). It has to claim without payloads
  // for the same reason the first one does, or the stall it fixes is replaced by
  // the cost it was fixing.
  const clock = { ms: 1_000_000 }
  const rows = [
    row('sc1', 'source-change', 1_000),
    row('sc2', 'source-change', 1_000),
    row('act', 'activity-event', 1_000),
  ]
  const { delivery, sent, outbox } = runtimeOver(rows, { clock, flushByteBudget: 1_048_576 })

  delivery.flushDurable()          // everything goes out, nothing is acked
  const readsAfterFirst = outbox.counts.payloadReads
  clock.ms += 30_000               // inside the deadline: sc1 blocks its stream
  delivery.flushDurable()

  assert.equal(outbox.counts.payloadReads, readsAfterFirst,
    'a pass that sends nothing reads nothing, through either query')
  assert.equal(sent.length, 3)
})

test('the byte budget is required — a runtime without one cannot bound a tick', () => {
  assert.throws(() => new DaemonDeliveryRuntime({
    outbox: countingOutbox([]),
    send: () => true,
    isConnected: () => true,
    isReady: () => true,
    inflightDeadlineMs: DEADLINE_MS,
  }), /positive flushByteBudget/)
})
