import assert from 'node:assert/strict'
import test from 'node:test'

import { convertChatEvents } from '../src/fleet/convert-chat-event.mjs'

test('chat intake preserves amendment events for the renderer to fold', () => {
  const events = convertChatEvents([
    {
      id: 12,
      type: 'amend',
      from_id: 'fleet:writer',
      recipients: ['fleet:skip'],
      text: 'corrected text',
      timestamp: '2026-08-08T02:31:46.688Z',
      metadata: JSON.stringify({ amends: 7 }),
    },
  ])

  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'amend')
  assert.equal(events[0]._dbId, 12)
  assert.equal(events[0].metadata.amends, 7)
})
