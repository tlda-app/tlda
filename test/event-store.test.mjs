import assert from 'node:assert/strict'
import test from 'node:test'

import { makeEventStore } from '../src/fleet/event-store.mjs'

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
