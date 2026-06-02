// Regression test for the chat double-render bug: a send whose WS reply is lost
// during a server hiccup leaves an optimistic entry with a _tempId and no _dbId
// (marked _failed → "⚠ not sent"). When the real message's echo arrives it must
// bind to that orphaned entry — reconciling into ONE sent entry — not append a
// second "☑ sent" copy.
//
// Run: node --test tests/optimistic-reconcile.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindOptimisticEcho } from '../src/fleet/optimistic-reconcile.mjs'

// A failed-then-recovered optimistic entry, as left by sendWithRetry exhausting
// its attempts: _tempId still present, no _dbId, _failed set.
function failedOptimistic() {
  return {
    _tempId: 'opt-123-abc',
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:alice',
    text: 'hello there',
    timestamp: '2026-06-02T10:00:00.000Z', // client clock — differs from server ts
    _failed: true,
  }
}

test('live path: echo carrying _tempId binds to the orphaned optimistic entry', () => {
  const events = [failedOptimistic()]
  // Live fleet-event echo carries the _tempId the server now echoes back.
  const bound = bindOptimisticEcho(events, 5001, e => e._tempId === 'opt-123-abc')
  assert.equal(bound, true)
  assert.equal(events.length, 1, 'no duplicate appended')
  const ev = events[0]
  assert.equal(ev._dbId, 5001, 'adopts the server event id')
  assert.equal(ev._tempId, undefined, '_tempId cleared so later echoes append normally')
  assert.equal(ev._failed, undefined, '"not sent" mark cleared — it actually went through')
})

test('catch-up path: echo with no _tempId binds by content (same sender + text)', () => {
  const events = [failedOptimistic()]
  // Reconnect catch-up rows come from the DB and carry no _tempId — match by content.
  const echo = { from: 'fleet:skip', text: 'hello there' }
  const bound = bindOptimisticEcho(events, 5002, e => e.from === echo.from && e.text === echo.text)
  assert.equal(bound, true)
  assert.equal(events.length, 1)
  assert.equal(events[0]._dbId, 5002)
  assert.equal(events[0]._failed, undefined)
})

test('already-reconciled entry is not rebound (no _tempId)', () => {
  // An optimistic entry the reply DID reconcile: has _dbId, no _tempId.
  const events = [{ _dbId: 4000, from: 'fleet:skip', text: 'hello there', type: 'chat' }]
  const bound = bindOptimisticEcho(events, 9999, e => e.from === 'fleet:skip' && e.text === 'hello there')
  assert.equal(bound, false, 'does not touch an entry that already has a _dbId')
  assert.equal(events[0]._dbId, 4000)
})

test('second broadcast recipient does not rebind the same entry', () => {
  // After the first echo binds (entry now has _dbId, no _tempId), a second
  // recipient echo with the same _tempId must NOT match — it should append.
  const events = [failedOptimistic()]
  assert.equal(bindOptimisticEcho(events, 6001, e => e._tempId === 'opt-123-abc'), true)
  const second = bindOptimisticEcho(events, 6002, e => e._tempId === 'opt-123-abc')
  assert.equal(second, false, 'no double-bind; the second recipient echo appends as its own line')
})

test('no matching optimistic entry → returns false, leaves array untouched', () => {
  const events = [{ _dbId: 1, from: 'fleet:bob', text: 'unrelated', type: 'chat' }]
  const bound = bindOptimisticEcho(events, 7000, e => e._tempId === 'nope')
  assert.equal(bound, false)
  assert.equal(events.length, 1)
})
