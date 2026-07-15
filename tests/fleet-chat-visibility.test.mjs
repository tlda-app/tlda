import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isTerminalAvailableForAgent,
  mergeVisibleChatEvents,
} from '../src/fleet/fleet-chat-visibility.mjs'

test('filtered chat keeps the global live tail while its history buffer is empty', () => {
  const live = { _dbId: 42, type: 'chat', from: 'fleet:skip', to: 'fleet:agent', text: 'still here' }
  assert.deepEqual(mergeVisibleChatEvents([], [live]), [live])
})

test('filtered chat merges scrollback and live events without duplicate rows', () => {
  const old = { _dbId: 40, type: 'chat', text: 'old' }
  const shared = { _dbId: 41, type: 'chat', text: 'shared' }
  const live = { _dbId: 42, type: 'chat', text: 'live' }
  assert.deepEqual(
    mergeVisibleChatEvents([old, shared], [{ ...shared }, live]).map(event => event._dbId),
    [40, 41, 42],
  )
})

test('awake agent terminal availability follows durable seat routing, not roster tmux fields', () => {
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', status: 'awake', tmux_session: null }), true)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', status: 'hibernating', tmux_session: 'old' }), false)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', status: 'shell' }), false)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', status: 'awake', dead: true }), false)
})
