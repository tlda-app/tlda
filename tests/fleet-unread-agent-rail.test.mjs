import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getUnreadAgentRailRows,
  isOnlyOwnedChat,
} from '../src/shapes/fleet-unread-agent-rail.ts'

test('unread sender rail contains only unread live agents, newest first', () => {
  const rows = getUnreadAgentRailRows([
    { id: 'fleet:older', friendly_name: 'older', last_seen: '2026-07-18T04:00:00Z' },
    { id: 'fleet:newer', friendly_name: 'newer', last_seen: '2026-07-18T05:00:00Z' },
    { id: 'fleet:read', friendly_name: 'read', last_seen: '2026-07-18T06:00:00Z' },
    { id: 'fleet:dead', friendly_name: 'dead', dead: true, last_seen: '2026-07-18T07:00:00Z' },
  ], {
    'fleet:older': 1,
    'fleet:newer': 2,
    'fleet:dead': 4,
  })

  assert.deepEqual(rows.map((row) => row.id), ['fleet:newer', 'fleet:older'])
  assert.deepEqual(rows.map((row) => row.exactName), ['newer', 'older'])
})

test('rail follows the current device surface: exactly one owned chat', () => {
  const chat = { id: 'shape:chat', type: 'fleet-chat' }
  assert.equal(isOnlyOwnedChat([chat], chat.id), true)
  assert.equal(isOnlyOwnedChat([chat], 'shape:other-chat'), false)
  assert.equal(isOnlyOwnedChat([
    chat,
    { id: 'shape:agents', type: 'fleet-agents' },
  ], chat.id), true)
  assert.equal(isOnlyOwnedChat([
    chat,
    { id: 'shape:other-chat', type: 'fleet-chat' },
  ], chat.id), false)
})
