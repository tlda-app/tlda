import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTimerParticipants } from './timer-routing.mjs'

test('timer participants resolve friendly names through an async store client', async () => {
  const agents = new Map([
    ['chief', { id: 'fleet:chief' }],
    ['app-tester', { id: 'fleet:app-tester' }],
  ])
  const resolved = await resolveTimerParticipants({
    agent: 'chief',
    toAgent: 'app-tester',
    findAgent: async key => agents.get(key) || null,
    fallbackOwner: 'fleet:skip',
  })
  assert.deepEqual(resolved, {
    from: 'fleet:chief',
    to: 'fleet:app-tester',
  })
})
