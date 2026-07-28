import assert from 'node:assert/strict'
import test from 'node:test'

test('temp-to-db reconciliation preserves the sender panel row', async () => {
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = () => ({})
  globalThis.window = {
    __TLDA_CONFIG__: {
      name: 'test',
      database: { http: 'http://test.invalid', ws: 'ws://test.invalid' },
      store: { http: 'http://test.invalid', ws: 'ws://test.invalid' },
      licenseKey: '',
    },
    location: { search: '' },
    addEventListener: () => {},
  }
  globalThis.location = window.location
  globalThis.localStorage = { getItem: () => null }
  const {
    clearFleetEventBuffer,
    getFilteredFleetEvents,
    upsertFleetEvent,
    upsertLocalEventIntoBuffer,
  } = await import('../src/fleet/fleet-data.ts')
  globalThis.setInterval = realSetInterval
  const bufferKey = 'chat:test-optimistic-rekey'
  const event = {
    _tempId: 'temp-test-optimistic-rekey',
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:chief',
    text: 'persist through reconciliation',
    timestamp: new Date().toISOString(),
  }
  const opts = { bufferKey, matchesFilter: () => true }

  try {
    getFilteredFleetEvents(null, opts)
    upsertFleetEvent(event)
    upsertLocalEventIntoBuffer(bufferKey, event)
    assert.equal(getFilteredFleetEvents(null, opts).length, 1)

    event._dbId = 2005058
    delete event._tempId
    upsertFleetEvent(event)

    const rows = getFilteredFleetEvents(null, opts)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]._dbId, 2005058)
    assert.equal(rows[0].text, 'persist through reconciliation')
  } finally {
    clearFleetEventBuffer(bufferKey)
  }
})
