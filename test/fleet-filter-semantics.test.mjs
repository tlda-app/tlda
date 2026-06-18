import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesFleetFilter, resolveFleetFilter } from '../src/fleet/filter-semantics.mjs'

const human = { id: 'fleet:skip', friendly_name: 'skip', status: 'human', labels: [] }
const agent = { id: 'fleet:worker', friendly_name: 'worker', status: 'awake', labels: ['reviewers'] }
const context = { agents: [human, agent], humanId: human.id, humanName: human.friendly_name }

const dmFilter = [
  [['from', 'skip'], ['to', 'worker']],
  [['from', 'worker'], ['to', 'skip']],
]

const agentFilter = [
  [['from', 'worker']],
  [['to', 'worker']],
]

test('DM filter matches only direct human-agent chat', () => {
  assert.equal(matchesFleetFilter(dmFilter, {
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:worker',
  }, context), true)

  assert.equal(matchesFleetFilter(dmFilter, {
    type: 'chat',
    from: 'fleet:worker',
    to: 'fleet:skip',
  }, context), true)

  assert.equal(matchesFleetFilter(dmFilter, {
    type: 'chat',
    from: 'fleet:worker',
    to: 'fleet:other',
  }, context), false)
})

test('DM filter excludes self-addressed activity for the agent', () => {
  const activity = {
    type: 'activity',
    from: 'fleet:worker',
    to: 'fleet:worker',
    agent: 'fleet:worker',
    _activity: true,
  }

  assert.equal(matchesFleetFilter(dmFilter, activity, context), false)
})

test('Agent and All filters include self-addressed activity for the agent', () => {
  const activity = {
    type: 'activity',
    from: 'fleet:worker',
    to: 'fleet:worker',
    agent: 'fleet:worker',
    _activity: true,
  }

  assert.equal(matchesFleetFilter(agentFilter, activity, context), true)
  assert.equal(matchesFleetFilter([], activity, context), true)
  assert.equal(matchesFleetFilter(null, activity, context), true)
})

test('resolved history agent sets follow DM and Agent preset intent', () => {
  assert.deepEqual([...resolveFleetFilter(dmFilter, context)].sort(), ['fleet:skip', 'fleet:worker'])
  assert.deepEqual([...resolveFleetFilter(agentFilter, context)], ['fleet:worker'])
})
