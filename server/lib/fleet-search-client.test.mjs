// A fleet search request that the child never answers must end, and must say why.
//
// Before this, `FleetSearchClient._pending` had no timeout anywhere. Entries were
// removed on a reply, or by `_fail` when the child ERRORED or EXITED. A child that
// was alive but not replying therefore held every request FOREVER, and the only
// thing that ended them was the caller's own 45s WS deadline -- which reports a
// socket timeout and tells you nothing about why.
//
// That is the shape this box actually produces. The child is forked at
// PRIORITY_BELOW_NORMAL onto a 2-CPU machine, so it can be
// starved for minutes while the main thread stays healthy: measured 2026-09-03
// across a 20-minute outage, peak event-loop lag was 931ms. The priority is
// deliberate and stays -- communications win the box ahead of search -- so the
// requirement is that search DEGRADES rather than dies.
//
// The second test is the one that stops this fix becoming a new defect. A bound
// that fires on a healthy-but-slow search would turn working queries into errors,
// which is worse than the hang it replaces.
//
// The child is stubbed rather than forked because the condition under test is
// "the child does not reply" -- reproducing that with a real subprocess would mean
// arranging for a real starved CPU, which is neither deterministic nor faster.
// What is exercised is exactly the client-side bookkeeping that was missing.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { FleetSearchClient } from './fleet-search-client.mjs'

// A child that accepts sends and replies only when the test tells it to.
class StubChild extends EventEmitter {
  constructor() {
    super()
    this.sent = []
  }
  send(message) {
    this.sent.push(message)
    // The real child answers a close handshake; without this `close()` waits
    // forever and every test that tidies up times out instead of failing on
    // what it was actually asserting.
    if (message?.kind === 'close') setImmediate(() => this.emit('message', { id: message.id }))
  }
  kill(signal) { this.killed = signal || true; this.emit('exit', null, signal || 'SIGKILL') }
}

class StubClient extends FleetSearchClient {
  _spawn(index) {
    const worker = this._workers[index] || { index, inflight: new Set() }
    this._workers[index] = worker
    worker.ready = Promise.resolve()
    worker.child = new StubChild()
    worker.child.on('message', message => {
      const waiter = this._pending.get(message?.id)
      if (!waiter) return
      this._pending.delete(message.id)
      worker.inflight.delete(message.id)
      if (waiter.timer) clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
    // Same exit wiring as a real child, via the class rather than a copy.
    worker.child.on('exit', (code, signal) => this._onChildExit(worker, code, signal))
    return worker
  }
}

// Bounded so that WITHOUT the fix this fails in five seconds instead of hanging
// the suite forever -- an unbounded hang is indistinguishable from an infrastructure
// problem, which is the thing this whole change is about.
test('a request the child never answers rejects, and does not guess why', { timeout: 5000 }, async () => {
  process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS = '150'
  const client = new StubClient('/nonexistent.db', { workers: 1 })

  // Captured before the request: a recycle respawns, so `_workers[0].child` is
  // a NEW child by the time the assertion runs and would never look killed.
  const childBefore = client._workers[0].child
  const started = Date.now()
  await assert.rejects(
    client.searchAll({ query: 'anything' }),
    (error) => {
      // Name what happened and the things that cause it -- never one of them as
      // fact. This message used to assert "which is CPU starvation ... not your
      // query being too large", which the timeout cannot possibly know: on
      // 2026-09-12 it fired for a query whose agent term resolved to 435 ids
      // while the same box answered a trivial read in 563ms, and a chief spent
      // the night on the wrong cause because this sentence sounded certain.
      assert.match(error.message, /fleet search child did not answer/)
      assert.match(error.message, /BELOW_NORMAL/)
      assert.match(error.message, /resolving to many ids/)
      assert.match(error.message, /TLDA_SEARCH_REQUEST_TIMEOUT_MS/)
      // It must not re-acquire a confident single cause.
      assert.doesNotMatch(error.message, /not your query being too large/)

      // The timeout now CANCELS, by killing the child, so the message says so.
      // While it did not, the honest advice was to stop issuing queries -- each
      // retry added another uncancellable scan to a saturated box, and a chief
      // following the old "run a trivial search to check" advice four times in
      // two hours became a meaningful share of the load they were reporting.
      assert.match(error.message, /killed and restarted/)
      assert.match(error.message, /no longer running/)
      // The old text is now FALSE and must not survive: saying the query is
      // still running would send a reader to hunt a process that is gone.
      assert.doesNotMatch(error.message, /did NOT cancel/)
      assert.doesNotMatch(error.message, /still running and still holding/)
      // And it must never again tell anyone to issue a query to diagnose this.
      assert.doesNotMatch(error.message, /run a trivial search/)
      return true
    },
  )
  // It ended because of the bound, not because something else gave up later.
  assert.ok(Date.now() - started < 5000, 'must reject on its own bound, not hang')
  // The entry must not be left behind holding a resolve nobody will ever call.
  assert.equal(client._pending.size, 0)
  // The point of the change: the scan is actually stopped. `better-sqlite3` is
  // synchronous, so the child cannot read an IPC cancel or run a signal handler
  // while it is inside the query -- killing the process is the only thing that
  // reaches it. Asserting the wording without this would test the promise
  // rather than the behaviour.
  assert.ok(childBefore.killed, 'the timeout must kill the child, not just report')
})

test('CONTROL: a slow-but-live reply still succeeds and is not failed by the bound', async () => {
  process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS = '2000'
  const client = new StubClient('/nonexistent.db', { workers: 1 })

  const pending = client.searchAll({ query: 'anything' })
  // Comfortably slower than the 1000ms elapsed-log threshold, comfortably inside
  // the timeout: exactly the healthy-slow case this must not break.
  setTimeout(() => {
    const sent = client._workers[0].child.sent.at(-1)
    client._workers[0].child.emit('message', { id: sent.id, result: { results: ['ok'] } })
  }, 60)

  assert.deepEqual(await pending, { results: ['ok'] })
  assert.equal(client._pending.size, 0)
})

test('CONTROL: an error from the child still propagates as that error', async () => {
  process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS = '2000'
  const client = new StubClient('/nonexistent.db', { workers: 1 })

  const pending = client.searchAll({ query: 'anything' })
  setTimeout(() => {
    const sent = client._workers[0].child.sent.at(-1)
    client._workers[0].child.emit('message', { id: sent.id, error: { message: 'store exploded' } })
  }, 10)

  await assert.rejects(pending, /store exploded/)
  assert.equal(client._pending.size, 0)
})

// The point of a pool, and the two properties worth asserting about it. One
// child meant a single slow query blocked every other search, and recycling it
// on timeout cancelled queries that had done nothing wrong.
test('a query occupying one worker does not block a query on another', { timeout: 5000 }, async () => {
  process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS = '5000'
  const client = new StubClient('/nonexistent.db', { workers: 2 })

  // First request goes to a worker and is never answered.
  const stuck = client.searchAll({ query: 'slow' })
  // The send happens after the readiness handshake resolves, so the routing is
  // not observable until a tick has passed.
  await new Promise(resolve => setImmediate(resolve))
  const busy = client._workers.find(w => w.inflight.size === 1)
  assert.ok(busy, 'the first request occupies exactly one worker')

  // The second must be routed to the other worker rather than queued behind it.
  const quick = client.searchAll({ query: 'fast' })
  const other = client._workers.find(w => w !== busy)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(other.inflight.size, 1, 'the second request went to the idle worker')

  const quickId = other.child.sent.at(-1).id
  other.child.emit('message', { id: quickId, result: ['answered'] })
  assert.deepEqual(await quick, ['answered'], 'it answers while the other worker is still stuck')

  stuck.catch(() => {})
  await client.close()
})

test('recycling one worker does not cancel queries on the others', { timeout: 5000 }, async () => {
  process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS = '5000'
  const client = new StubClient('/nonexistent.db', { workers: 2 })

  const doomed = client.searchAll({ query: 'doomed' })
  await new Promise(resolve => setImmediate(resolve))
  const busy = client._workers.find(w => w.inflight.size === 1)
  const survivor = client.searchAll({ query: 'survivor' })
  await new Promise(resolve => setImmediate(resolve))
  const other = client._workers.find(w => w !== busy)

  client._recycle(busy, 'a test said so')
  await assert.rejects(doomed, /restarted because a test said so/)

  // The survivor is untouched: its worker was never killed, and it still answers.
  const survivorId = other.child.sent.at(-1).id
  other.child.emit('message', { id: survivorId, result: ['still here'] })
  assert.deepEqual(await survivor, ['still here'], 'a recycle is confined to its own worker')

  await client.close()
})
