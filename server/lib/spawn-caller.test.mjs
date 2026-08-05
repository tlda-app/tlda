import assert from 'node:assert/strict'
import test from 'node:test'

import { spawnCallerId } from './spawn-caller.mjs'

test('spawn uses the declared operation sender while reconnect login is pending', () => {
  assert.equal(spawnCallerId({}, {
    fleet_operation: { sender: 'fleet:skip' },
  }), 'fleet:skip')
})

test('spawn prefers the identity attached to the websocket', () => {
  assert.equal(spawnCallerId({ _tldaHumanId: 'fleet:here' }, {
    fleet_operation: { sender: 'fleet:stale' },
  }), 'fleet:here')
})
