// Regression coverage for optimistic chat reconciliation at the converter
// boundary. The event store can only bind a server echo to a pending optimistic
// row if convertChatEvent preserves the client temp id from the live echo or
// history replay metadata.
//
// Run: node --import tsx --test tests/chat-tempid-convert.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEventStore } from '../src/fleet/event-store.mjs'

globalThis.window = {
  location: { search: '' },
  addEventListener() {},
  __TLDA_CONFIG__: {
    name: 'test',
    database: { http: 'http://127.0.0.1:5176', ws: 'ws://127.0.0.1:5176' },
    store: { http: 'http://127.0.0.1:5176', ws: 'ws://127.0.0.1:5176' },
    licenseKey: '',
  },
}
globalThis.location = globalThis.window.location
globalThis.BroadcastChannel = undefined
globalThis.localStorage = {
  getItem() { return null },
  setItem() {},
}

const {
  convertChatEvent,
  getFleetRuntimeSummary,
  recordBrowserActivityRendered,
} = await import('../src/fleet/fleet-data.mjs')
const { ACTIVITY_DELIVERY_STAGES } = await import('../shared/activity-delivery-counters.mjs')

function strandedOptimisticStore() {
  const store = makeEventStore()
  store.upsert({
    _tempId: 'opt-live-1',
    _failed: true,
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:agent',
    text: 'one message',
    timestamp: '2026-06-23T22:00:00.000Z',
  })
  return store
}

test('live fleet-event echo preserves _tempId and binds the optimistic row', () => {
  const store = strandedOptimisticStore()
  const converted = convertChatEvent({
    id: 9001,
    type: 'chat',
    from_id: 'fleet:skip',
    to_id: 'fleet:agent',
    text: 'one message',
    timestamp: '2026-06-23T22:00:01.000Z',
    _tempId: 'opt-live-1',
  })

  const { event, isNew } = store.upsert(converted)
  assert.equal(isNew, false)
  assert.equal(store.size(), 1)
  assert.equal(event._dbId, 9001)
  assert.equal(event._tempId, undefined)
  assert.equal(event._failed, undefined)
})

test('history replay metadata preserves client_temp_id and binds the optimistic row', () => {
  const store = strandedOptimisticStore()
  const converted = convertChatEvent({
    id: 9002,
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:agent',
    text: 'one message',
    timestamp: '2026-06-23T22:00:02.000Z',
    metadata: JSON.stringify({ client_temp_id: 'opt-live-1' }),
  })

  const { event, isNew } = store.upsert(converted)
  assert.equal(isNew, false)
  assert.equal(store.size(), 1)
  assert.equal(event._dbId, 9002)
  assert.equal(event._tempId, undefined)
  assert.equal(event._failed, undefined)
})

test('browser rendered activity counter counts event ids once across multiple chat surfaces', () => {
  const before = getFleetRuntimeSummary().activityDelivery.byStage.browserRendered?.total || 0
  const group = [
    { _dbId: 'render-once-a', from: 'fleet:agent', text: 'tool-a' },
    { _dbId: 'render-once-b', from: 'fleet:agent', text: 'tool-b' },
  ]

  recordBrowserActivityRendered(ACTIVITY_DELIVERY_STAGES.BROWSER_RENDERED, group, group.length)
  recordBrowserActivityRendered(ACTIVITY_DELIVERY_STAGES.BROWSER_RENDERED, group, group.length)

  const after = getFleetRuntimeSummary().activityDelivery.byStage.browserRendered?.total || 0
  assert.equal(after - before, 2)
})
