import assert from 'node:assert/strict'
import test from 'node:test'

import { countAwakeFleetAgents } from '../src/fleet/agent-counts.ts'

test('fleet HUD badge counts awake agents only', () => {
  const agents = [
    { id: 'fleet:awake', status: 'awake', dead: false, human: false },
    { id: 'fleet:hibernating', status: 'hibernating', dead: false, human: false },
    { id: 'fleet:dead', status: 'dead', dead: true, human: false },
    { id: 'fleet:skip', status: 'human', dead: false, human: true },
  ]

  assert.equal(countAwakeFleetAgents(agents), 1)
})
