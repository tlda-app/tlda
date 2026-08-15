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

test('chat intake keeps transport and authoritative source metadata separate', () => {
  const [event] = convertChatEvents([{
    id: 13,
    type: 'chat',
    from_id: 'fleet:writer',
    recipients: ['fleet:skip'],
    text: 'from a file through a terminal',
    timestamp: '2026-08-14T02:31:46.688Z',
    metadata: {
      via: 'terminal',
      source: { file: '/tmp/report.md', selector: '#result', url: '/uploads/report.md' },
    },
  }])

  assert.equal(event.metadata.via, 'terminal')
  assert.deepEqual(event.metadata.source, {
    file: '/tmp/report.md', selector: '#result', url: '/uploads/report.md',
  })
})
