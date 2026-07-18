import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isTerminalAvailableForAgent,
} from '../src/fleet/fleet-chat-visibility.mjs'

test('terminal availability follows durable seat routing; hibernation does not hide a routable terminal', () => {
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'awake' }, tmux_session: null }), true)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', hibernating: true, runtime_status: { status: 'awake', route_state: 'routable' } }), true)
  // A hibernating agent's pane still exists — it must stay inspectable.
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'hibernating' }, tmux_session: 'old' }), true)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'hibernating', route_state: 'routable' } }), true)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'hibernating', route_state: 'unroutable' } }), false)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'shell' } }), false)
  assert.equal(isTerminalAvailableForAgent({ id: 'fleet:a', runtime_status: { status: 'awake' }, dead: true }), false)
})
