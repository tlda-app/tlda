// A fleet search request that the child never answers must end, and must say why.
//
// Before this, `FleetSearchClient._pending` had no timeout anywhere. Entries were
// removed on a reply, or by `_fail` when the child ERRORED or EXITED. A child that
// was alive but not replying therefore held every request FOREVER, and the only
// thing that ended them was the caller's own 45s WS deadline -- which reports a
// socket timeout and tells you nothing about why.
//
// That is the shape this box actually produces. The child is forked at
// PRIORITY_BELOW_NORMAL onto a 2-CPU machine that also runs builds, so it can be
// starved for minutes while the main thread stays healthy: measured 2026-09-03
// across a 20-minute outage, peak event-loop lag was 931ms.
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
  send(message) { this.sent.push(message) }
  kill() {}
}

class StubClient extends FleetSearchClient {
  _spawn() {
    this._ready = Promise.resolve()
    this._child = new StubChild()
    this._child.on('message', message => {
      const waiter = this._pending.get(message?.id)
      if (!waiter) return
      this._pending.delete(message.id)
      if (waiter.timer) clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
    })
  }
}

// Bounded so that WITHOUT the fix this fails in five seconds instead of hanging
// the suite forever -- an unbounded hang is indistinguishable from an infrastructure
// problem, which is the thing this whole change is about.
test('a request the child never answers rejects, and names the starved child', { timeout: 5000 }, async () => {
  process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS = '150'
  const client = new StubClient('/nonexistent.db')

  const started = Date.now()
  await assert.rejects(
    client.searchAll({ query: 'anything' }),
    (error) => {
      // Name the cause, not the socket -- the caller must learn the child is
      // starved, not that "something timed out".
      assert.match(error.message, /fleet search child did not answer/)
      assert.match(error.message, /BELOW_NORMAL/)
      assert.match(error.message, /TLDA_SEARCH_REQUEST_TIMEOUT_MS/)
      return true
    },
  )
  // It ended because of the bound, not because something else gave up later.
  assert.ok(Date.now() - started < 5000, 'must reject on its own bound, not hang')
  // The entry must not be left behind holding a resolve nobody will ever call.
  assert.equal(client._pending.size, 0)
})

test('CONTROL: a slow-but-live reply still succeeds and is not failed by the bound', async () => {
  process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS = '2000'
  const client = new StubClient('/nonexistent.db')

  const pending = client.searchAll({ query: 'anything' })
  // Comfortably slower than the 1000ms elapsed-log threshold, comfortably inside
  // the timeout: exactly the healthy-slow case this must not break.
  setTimeout(() => {
    const sent = client._child.sent.at(-1)
    client._child.emit('message', { id: sent.id, result: { results: ['ok'] } })
  }, 60)

  assert.deepEqual(await pending, { results: ['ok'] })
  assert.equal(client._pending.size, 0)
})

test('CONTROL: an error from the child still propagates as that error', async () => {
  process.env.TLDA_SEARCH_REQUEST_TIMEOUT_MS = '2000'
  const client = new StubClient('/nonexistent.db')

  const pending = client.searchAll({ query: 'anything' })
  setTimeout(() => {
    const sent = client._child.sent.at(-1)
    client._child.emit('message', { id: sent.id, error: { message: 'store exploded' } })
  }, 10)

  await assert.rejects(pending, /store exploded/)
  assert.equal(client._pending.size, 0)
})
