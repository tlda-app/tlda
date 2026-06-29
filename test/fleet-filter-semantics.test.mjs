import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFleetAgentFilter,
  buildFleetDmFilter,
  classifyFleetComposerTrafficMode,
  filterForFleetComposerTrafficMode,
  matchesFleetFilter,
  nextFleetComposerTrafficMode,
  quietTrafficSuppressesActivity,
  resolveFleetFilter,
  sameFleetFilter,
} from '../src/fleet/filter-semantics.mjs'

const human = { id: 'fleet:dmitry', friendly_name: 'dmitry', status: 'human', labels: [] }
const agent = { id: 'fleet:worker', friendly_name: 'worker', status: 'awake', labels: ['reviewers'] }
const context = { agents: [human, agent], humanId: human.id, humanName: human.friendly_name }

const dmFilter = [[['dm', 'worker']]]

const agentFilter = [
  [['from', 'worker']],
  [['to', 'worker']],
]

test('DM filter matches only direct human-agent chat', () => {
  assert.equal(matchesFleetFilter(dmFilter, {
    type: 'chat',
    from: 'fleet:dmitry',
    to: 'fleet:worker',
  }, context), true)

  assert.equal(matchesFleetFilter(dmFilter, {
    type: 'chat',
    from: 'fleet:worker',
  }, context), true)

  assert.equal(matchesFleetFilter(dmFilter, {
    type: 'chat',
    from: 'fleet:worker',
    to: 'fleet:dmitry',
  }, context), true)

  assert.equal(matchesFleetFilter(dmFilter, {
    type: 'chat',
    from: 'fleet:worker',
    to: 'fleet:other',
  }, context), false)
})

test('DM filter includes the target agent\'s own activity (DM ⚒ "tools visible" rung)', () => {
  // The "DM ⚒ / tools visible" rung is a DM filter with normal traffic; it must
  // show the target agent's own tool activity. The quiet rung (dm-quiet) hides it
  // via quietTrafficSuppressesActivity at the render layer, not via this filter.
  const activity = {
    type: 'activity',
    from: 'fleet:worker',
    to: 'fleet:worker',
    agent: 'fleet:worker',
    _activity: true,
  }

  assert.equal(matchesFleetFilter(dmFilter, activity, context), true)
})

test('DM filter excludes a DIFFERENT agent\'s activity', () => {
  // Scope guard: a DM filter for "worker" must not pull in some other agent's
  // tool activity just because it's an activity event.
  const otherActivity = {
    type: 'activity',
    from: 'fleet:other',
    agent: 'fleet:other',
    _activity: true,
  }

  assert.equal(matchesFleetFilter(dmFilter, otherActivity, context), false)
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
  assert.deepEqual([...resolveFleetFilter(dmFilter, context)].sort(), ['fleet:worker'])
  assert.deepEqual([...resolveFleetFilter(agentFilter, context)], ['fleet:worker'])
})

test('resolved history agent sets preserve explicit fleet ids without roster rows', () => {
  const filter = [
    [['from', 'viewer-pm']],
    [['to', 'fleet:8df9b9b1']],
  ]
  assert.deepEqual([...resolveFleetFilter(filter, { agents: [], humanId: human.id, humanName: human.friendly_name })], ['fleet:8df9b9b1'])
})

test('composer traffic presets classify and cycle DM quiet, DM, all agent traffic', () => {
  assert.deepEqual(buildFleetDmFilter('dmitry', 'worker'), dmFilter)
  assert.deepEqual(buildFleetAgentFilter('worker'), agentFilter)

  assert.equal(classifyFleetComposerTrafficMode(dmFilter, 'quiet', 'dmitry', 'worker'), 'dm-quiet')
  assert.equal(classifyFleetComposerTrafficMode(dmFilter, 'normal', 'dmitry', 'worker'), 'dm')
  assert.equal(classifyFleetComposerTrafficMode(agentFilter, 'normal', 'dmitry', 'worker'), 'agent')
  assert.equal(classifyFleetComposerTrafficMode(agentFilter, 'quiet', 'dmitry', 'worker'), 'agent')
  assert.equal(classifyFleetComposerTrafficMode([[['to', 'worker']]], 'normal', 'dmitry', 'worker'), 'custom')
  assert.equal(classifyFleetComposerTrafficMode(dmFilter, 'quiet', 'dmitry', ''), 'dm-quiet')
  assert.equal(classifyFleetComposerTrafficMode(dmFilter, 'normal', 'dmitry', ''), 'dm')
  assert.equal(classifyFleetComposerTrafficMode(agentFilter, 'normal', 'dmitry', ''), 'agent')
  assert.equal(classifyFleetComposerTrafficMode([[['to', 'worker']]], 'normal', 'dmitry', ''), 'custom')

  assert.equal(nextFleetComposerTrafficMode('dm-quiet'), 'dm')
  assert.equal(nextFleetComposerTrafficMode('dm'), 'agent')
  assert.equal(nextFleetComposerTrafficMode('agent'), 'dm-quiet')
  assert.equal(nextFleetComposerTrafficMode('custom'), 'dm-quiet')

  assert.equal(sameFleetFilter(filterForFleetComposerTrafficMode('dm-quiet', 'dmitry', 'worker'), dmFilter), true)
  assert.equal(sameFleetFilter(filterForFleetComposerTrafficMode('dm', 'dmitry', 'worker'), dmFilter), true)
  assert.equal(sameFleetFilter(filterForFleetComposerTrafficMode('agent', 'dmitry', 'worker'), agentFilter), true)
})

test('quiet traffic suppresses activity only for direct-message mode', () => {
  assert.equal(quietTrafficSuppressesActivity(dmFilter, 'quiet'), true)
  assert.equal(quietTrafficSuppressesActivity(dmFilter, 'normal'), false)
  assert.equal(quietTrafficSuppressesActivity(agentFilter, 'quiet'), false)
  assert.equal(quietTrafficSuppressesActivity([], 'quiet'), false)
  assert.equal(quietTrafficSuppressesActivity(null, 'quiet'), false)
})
