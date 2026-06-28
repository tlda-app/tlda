import assert from 'node:assert/strict'
import test from 'node:test'

import { makeEventStore } from '../src/fleet/event-store.mjs'

function eventAt(id, minute) {
  return {
    _dbId: id,
    type: 'chat',
    text: `event ${id}`,
    timestamp: `2026-06-28T12:${String(minute).padStart(2, '0')}:00.000Z`,
  }
}

test('failed optimistic events can be dismissed by temp id', () => {
  const store = makeEventStore()
  store.upsert({ _tempId: 'tmp-1', _failed: true, text: 'hello', timestamp: '2026-06-18T10:00:00.000Z' })
  store.upsert({ _dbId: 2, text: 'server row', timestamp: '2026-06-18T10:01:00.000Z' })

  assert.equal(store.size(), 2)
  assert.equal(store.removeByTempId('tmp-1')?.text, 'hello')
  assert.equal(store.size(), 1)
  assert.equal(store.get('tmp:tmp-1'), undefined)
  assert.deepEqual(store.all().map(e => e.text), ['server row'])
  assert.equal(store.removeByTempId('tmp-1'), null)
})

test('live event after scrollback does not clear loaded backlog', () => {
  const store = makeEventStore({ maxEvents: 5 })
  store.upsertMany([eventAt(10, 10), eventAt(11, 11), eventAt(12, 12)])

  store.upsertMany([eventAt(6, 6), eventAt(7, 7), eventAt(8, 8), eventAt(9, 9)], { evict: 'newest' })
  assert.deepEqual(store.all().map(e => e._dbId), [6, 7, 8, 9, 10])

  store.upsert(eventAt(13, 13))
  assert.deepEqual(
    store.all().map(e => e._dbId),
    [7, 8, 9, 10, 13],
    'posting at the tail should evict only the oldest row, not reset to recent-only',
  )
})

test('event store remains bounded while preserving newer live rows', () => {
  const store = makeEventStore({ maxEvents: 3 })
  store.upsertMany([eventAt(5, 5), eventAt(6, 6), eventAt(7, 7)])
  store.upsertMany([eventAt(2, 2), eventAt(3, 3), eventAt(4, 4)], { evict: 'newest' })
  assert.deepEqual(store.all().map(e => e._dbId), [2, 3, 4])

  store.upsert(eventAt(8, 8))
  store.upsert(eventAt(9, 9))
  assert.deepEqual(store.all().map(e => e._dbId), [4, 8, 9])
  assert.equal(store.size(), 3)
})
