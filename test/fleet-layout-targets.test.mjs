import assert from 'node:assert/strict'
import test from 'node:test'

import { recentChatTargetAgents } from '../src/fleet/layout-targets.mjs'

const agents = [
  { id: 'fleet:old', friendly_name: 'old-agent', human: false },
  { id: 'fleet:new', friendly_name: 'new-agent', human: false },
  { id: 'fleet:tool', friendly_name: 'tool-agent', human: false },
  { id: 'fleet:skip', friendly_name: 'skip', human: true },
]

test('recent chat targets are ordered by latest human-agent chat', () => {
  const events = [
    { type: 'chat', from: 'fleet:skip', to: 'fleet:old', timestamp: '2026-06-18T05:00:00Z', _dbId: 1 },
    { type: 'activity', from: 'fleet:tool', to: 'fleet:tool', agent: 'fleet:tool', timestamp: '2026-06-18T05:30:00Z', _dbId: 2 },
    { type: 'chat', from: 'fleet:new', to: 'fleet:skip', timestamp: '2026-06-18T06:00:00Z', _dbId: 3 },
    { type: 'chat', from: 'fleet:skip', to: 'fleet:old', timestamp: '2026-06-18T06:30:00Z', _dbId: 4 },
    { type: 'chat', from: 'fleet:skip', to: 'fleet:unknown', timestamp: '2026-06-18T07:00:00Z', _dbId: 5 },
  ]

  assert.deepEqual(
    recentChatTargetAgents(events, agents, 'fleet:skip', 'skip', 2).map((agent) => agent.friendly_name),
    ['old-agent', 'new-agent'],
  )
})

test('recent chat targets resolve friendly-name human labels', () => {
  const events = [
    { type: 'chat', from: 'skip', to: 'new-agent', timestamp: '2026-06-18T06:00:00Z', _dbId: 3 },
  ]

  assert.deepEqual(
    recentChatTargetAgents(events, agents, 'fleet:skip', 'skip', 1).map((agent) => agent.id),
    ['fleet:new'],
  )
})
