import assert from 'node:assert/strict'
import test from 'node:test'

import { unroutedNativeDescendantIds } from './native-subagent-lifecycle.mjs'

test('parent lifecycle changes include only native descendants without their own route', () => {
  const agents = [
    { id: 'fleet:native-child', parent_agent_id: 'fleet:parent', route_present: false },
    { id: 'fleet:native-grandchild', parent_agent_id: 'fleet:native-child', route_present: false },
    { id: 'fleet:independent-child', parent_agent_id: 'fleet:parent', route_present: true },
    { id: 'fleet:other-child', parent_agent_id: 'fleet:other', route_present: false },
  ]

  assert.deepEqual(
    unroutedNativeDescendantIds(agents, 'fleet:parent'),
    ['fleet:native-child', 'fleet:native-grandchild'],
  )
})
