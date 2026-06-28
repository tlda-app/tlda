import assert from 'node:assert/strict'
import test from 'node:test'

import { makeEventStore } from '../src/fleet/event-store.mjs'

function eventAt(id) {
  const ms = Date.UTC(2026, 5, 28, 12, 0, id)
  return {
    _dbId: id,
    type: 'chat',
    text: `event ${id}`,
    timestamp: new Date(ms).toISOString(),
  }
}

function ids(store) {
  return store.all().map(e => e._dbId)
}

function assertContiguousAscending(store) {
  const got = ids(store)
  for (let i = 1; i < got.length; i++) {
    assert.equal(got[i], got[i - 1] + 1, `gap between ${got[i - 1]} and ${got[i]}`)
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

test('scroll-back grows the buffer and evicts nothing', () => {
  const store = makeEventStore({ maxEvents: 5 })
  store.upsertMany([eventAt(10), eventAt(11), eventAt(12), eventAt(13), eventAt(14)])

  store.upsertMany([eventAt(6), eventAt(7), eventAt(8), eventAt(9)], { skipTrim: true })

  assert.equal(store.size(), 9)
  assert.deepEqual(ids(store), [6, 7, 8, 9, 10, 11, 12, 13, 14])
  assert.equal(store.get('db:14')?.text, 'event 14', 'live tail must remain present')
  assertContiguousAscending(store)
})

test('live append while pinned to bottom rotates out only the oldest', () => {
  const store = makeEventStore({ maxEvents: 3 })
  store.upsertMany([eventAt(5), eventAt(6), eventAt(7)])

  store.upsert(eventAt(8), { evict: 'oldest' })

  assert.deepEqual(ids(store), [6, 7, 8])
  assert.equal(store.size(), 3)
  assert.equal(store.get('db:5'), undefined)
  assert.equal(store.get('db:8')?.text, 'event 8')
  assertContiguousAscending(store)
})

test('live append while scrolled up does NOT evict the oldest', () => {
  const store = makeEventStore({ maxEvents: 3 })
  store.upsertMany([eventAt(5), eventAt(6), eventAt(7)])

  store.upsert(eventAt(8), { skipTrim: true })

  assert.deepEqual(ids(store), [5, 6, 7, 8])
  assert.equal(store.size(), 4)
  assert.equal(store.get('db:5')?.text, 'event 5', 'old viewed row must stay while scrolled up')
  assert.equal(store.get('db:8')?.text, 'event 8')
  assertContiguousAscending(store)
})
