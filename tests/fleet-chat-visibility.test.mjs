import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isTerminalAvailableForAgent,
} from '../src/fleet/fleet-chat-visibility.mjs'

test('awake agent terminal availability follows durable seat routing, not roster tmux fields', () => {
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'awake' }, tmux_session: null }), true)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', hibernating: true, runtime_status: { status: 'awake', route_state: 'routable' } }), true)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'hibernating' }, tmux_session: 'old' }), false)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'shell' } }), false)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'awake' }, dead: true }), false)
})
