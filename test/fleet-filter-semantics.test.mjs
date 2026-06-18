import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFleetAgentFilter,
  buildFleetDmFilter,
  classifyFleetComposerTrafficMode,
  filterForFleetComposerTrafficMode,
  matchesFleetFilter,
  nextFleetComposerTrafficMode,
  resolveFleetFilter,
  sameFleetFilter,
} from '../src/fleet/filter-semantics.mjs'

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

test('composer traffic presets classify and cycle DM quiet, DM, all agent traffic', () => {
  assert.deepEqual(buildFleetDmFilter('skip', 'worker'), dmFilter)
  assert.deepEqual(buildFleetAgentFilter('worker'), agentFilter)

  assert.equal(classifyFleetComposerTrafficMode(dmFilter, 'quiet', 'skip', 'worker'), 'dm-quiet')
  assert.equal(classifyFleetComposerTrafficMode(dmFilter, 'normal', 'skip', 'worker'), 'dm')
  assert.equal(classifyFleetComposerTrafficMode(agentFilter, 'normal', 'skip', 'worker'), 'agent')
  assert.equal(classifyFleetComposerTrafficMode([[['to', 'worker']]], 'normal', 'skip', 'worker'), 'custom')

  assert.equal(nextFleetComposerTrafficMode('dm-quiet'), 'dm')
  assert.equal(nextFleetComposerTrafficMode('dm'), 'agent')
  assert.equal(nextFleetComposerTrafficMode('agent'), 'dm-quiet')
  assert.equal(nextFleetComposerTrafficMode('custom'), 'dm-quiet')

  assert.equal(sameFleetFilter(filterForFleetComposerTrafficMode('dm-quiet', 'skip', 'worker'), dmFilter), true)
  assert.equal(sameFleetFilter(filterForFleetComposerTrafficMode('dm', 'skip', 'worker'), dmFilter), true)
  assert.equal(sameFleetFilter(filterForFleetComposerTrafficMode('agent', 'skip', 'worker'), agentFilter), true)
})
