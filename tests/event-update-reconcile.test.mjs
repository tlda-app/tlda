import assert from 'node:assert/strict'
import test from 'node:test'

import { applyFleetEventUpdate, eventUpdateFields } from '../src/fleet/event-update.mjs'

test('delegate next-fire event update reaches the rendered countdown field', () => {
  assert.deepEqual(eventUpdateFields({
    id: 99,
    metadata_patch: { next_fire_at: '2026-08-04T22:41:14.251Z' },
  }), {
    metadata: { next_fire_at: '2026-08-04T22:41:14.251Z' },
    _taskNextFireAt: '2026-08-04T22:41:14.251Z',
  })
})

test('live event-update intake patches the existing event id', () => {
  let received = null
  assert.equal(applyFleetEventUpdate({
    event_id: 99,
    metadata_patch: { next_fire_at: '2026-08-04T22:41:14.251Z' },
  }, (id, fields) => { received = { id, fields } }), true)
  assert.deepEqual(received, {
    id: 99,
    fields: {
      metadata: { next_fire_at: '2026-08-04T22:41:14.251Z' },
      _taskNextFireAt: '2026-08-04T22:41:14.251Z',
    },
  })
})

test('event update does not invent fields absent from the server patch', () => {
  assert.deepEqual(eventUpdateFields({ id: 99, metadata_patch: { pending: true } }), {
    metadata: { pending: true },
  })
})
