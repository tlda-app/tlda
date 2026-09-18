import test from 'node:test'
import assert from 'node:assert/strict'
import { chatMessageTimestampMs, compareChatMessagesChronologically } from '../src/fleet/chat-ordering.mjs'

const at = (iso: string, dbId?: number) => ({ timestamp: iso, _dbId: dbId })

test('ordering is unchanged by the cache', () => {
  const messages = [
    at('2026-09-18T05:00:03.000Z', 3),
    at('2026-09-18T05:00:01.000Z', 1),
    at('2026-09-18T05:00:02.000Z', 2),
  ]
  const sorted = [...messages].sort(compareChatMessagesChronologically)
  assert.deepEqual(sorted.map(m => m._dbId), [1, 2, 3])
  // Sorting again hits the cache on every element; the answer must not move.
  assert.deepEqual([...sorted].sort(compareChatMessagesChronologically).map(m => m._dbId), [1, 2, 3])
})

test('a changed timestamp re-parses rather than returning the cached value', () => {
  // The whole risk of caching against the object. If the raw string were not
  // re-checked, this would return the first value forever.
  const m: { timestamp: string } = { timestamp: '2026-09-18T05:00:00.000Z' }
  const first = chatMessageTimestampMs(m)
  m.timestamp = '2026-09-18T06:00:00.000Z'
  const second = chatMessageTimestampMs(m)
  assert.equal(second - first, 3_600_000)
})

test('the same object returns the same number on repeat calls', () => {
  const m = at('2026-09-18T05:00:00.000Z')
  assert.equal(chatMessageTimestampMs(m), chatMessageTimestampMs(m))
  assert.equal(chatMessageTimestampMs(m), Date.parse('2026-09-18T05:00:00.000Z'))
})

test('a missing or unparseable timestamp sorts last, as before', () => {
  assert.equal(chatMessageTimestampMs({} as never), Number.MAX_SAFE_INTEGER)
  assert.equal(chatMessageTimestampMs(null as never), Number.MAX_SAFE_INTEGER)
  assert.equal(chatMessageTimestampMs({ timestamp: 'not a date' }), Number.MAX_SAFE_INTEGER)
})

test('a non-object argument still works and is not cached', () => {
  // The WeakMap cannot key on a primitive; that path must fall through rather
  // than throw.
  assert.equal(chatMessageTimestampMs('2026-09-18T05:00:00.000Z' as never), Number.MAX_SAFE_INTEGER)
})

test('messages with equal timestamps still break the tie on id', () => {
  const same = '2026-09-18T05:00:00.000Z'
  const sorted = [at(same, 2), at(same, 1)].sort(compareChatMessagesChronologically)
  assert.deepEqual(sorted.map(m => m._dbId), [1, 2])
})
