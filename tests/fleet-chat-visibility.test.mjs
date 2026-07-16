import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isTerminalAvailableForAgent,
} from '../src/fleet/fleet-chat-visibility.mjs'

test('awake agent terminal availability follows durable seat routing, not roster tmux fields', () => {
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', status: 'awake', tmux_session: null }), true)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', status: 'hibernating', tmux_session: 'old' }), false)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', status: 'shell' }), false)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', status: 'awake', dead: true }), false)
})
