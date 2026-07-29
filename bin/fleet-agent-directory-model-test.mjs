import assert from 'node:assert/strict'

import {
  fleetAgentCategory,
  fleetAgentVisibleName,
  formatFleetAgentActivityHealthForAgent,
  projectFleetAgentDirectoryFolding,
  toFleetAgentDirectoryRow,
} from '../src/shapes/FleetAgentDirectoryModel.ts'
import {
  ACTIVITY_HEALTH_UNKNOWN,
  ACTIVITY_HEALTH_BOUNDARIES,
  ACTIVITY_HEALTH_UNAVAILABLE,
} from '../shared/activity-health.mjs'

const staleNoTmux = {
  state: ACTIVITY_HEALTH_UNAVAILABLE,
  boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
  reason: 'legacy transport health must not leak to humans',
}

const human = {
  id: 'fleet:skip-test-human',
  friendly_name: 'skip-test-human',
  human: true,
  dead: false,
  metadata: { activityHealth: staleNoTmux },
  registered_at: new Date().toISOString(),
  runtime_status: { kind: 'human', status: 'here' },
}

assert.equal(fleetAgentCategory(human), 'awake')
assert.equal(formatFleetAgentActivityHealthForAgent(human), '')
const humanRow = toFleetAgentDirectoryRow(human)
assert.equal(humanRow.activityHealth, '')
assert(!humanRow.hoverTitle.includes('tmux'))
assert(!humanRow.hoverTitle.includes('no-tmux'))
assert(!humanRow.hoverTitle.includes('not resumable'))

const routableAgent = {
  id: 'fleet:routable-agent',
  friendly_name: 'routable-agent',
  human: false,
  dead: false,
  metadata: { activityHealth: staleNoTmux },
  runtime_status: { kind: 'ai', status: 'awake', route_state: 'routable' },
  session_id: 'session-routable-agent',
  resume_id: 'session-routable-agent',
}

assert.equal(formatFleetAgentActivityHealthForAgent(routableAgent), '')
assert.equal(toFleetAgentDirectoryRow(routableAgent).activityHealth, '')

const disconnectedAgent = {
  ...routableAgent,
  runtime_status: { kind: 'ai', status: 'hibernating', route_state: 'daemon-disconnected' },
}

assert.equal(formatFleetAgentActivityHealthForAgent(disconnectedAgent), '')
assert(!toFleetAgentDirectoryRow(disconnectedAgent).hoverTitle.includes('tmux'))

const watcherFailureAgent = {
  ...routableAgent,
  metadata: {
    activityHealth: {
      state: ACTIVITY_HEALTH_UNKNOWN,
      boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR,
    },
  },
}

const watcherRow = toFleetAgentDirectoryRow(watcherFailureAgent)
assert.equal(watcherRow.activityHealth, 'activity unavailable:never')
assert(!watcherRow.activityHealth.includes('tmux'))
assert(!watcherRow.activityHealth.includes('daemon'))
assert(!watcherRow.activityHealth.includes('transport'))
assert(!watcherRow.activityHealth.includes('watch'))
assert(!watcherRow.activityHealth.includes('watch-runtime-error'))

const transportFailureAgent = {
  ...routableAgent,
  metadata: {
    activityHealth: {
      state: ACTIVITY_HEALTH_UNAVAILABLE,
      boundary: ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_DISCONNECTED,
    },
  },
}

const transportRow = toFleetAgentDirectoryRow(transportFailureAgent)
assert.equal(transportRow.activityHealth, 'activity unavailable:never')
assert(!transportRow.activityHealth.includes('daemon'))
assert(!transportRow.activityHealth.includes('transport'))

assert.equal(fleetAgentVisibleName({
  id: 'fleet:child',
  parent_agent_id: 'fleet:parent',
  friendly_name: 'chief13:Plan',
}), ':Plan')
assert.equal(fleetAgentVisibleName({
  id: 'fleet:parent',
  friendly_name: 'chief13',
}), 'chief13')

const parent = {
  id: 'fleet:parent',
  friendly_name: 'chief13',
  runtime_status: { kind: 'ai', status: 'awake', route_state: 'routable' },
}
const awakeChild = {
  id: 'fleet:awake-child',
  parent_agent_id: parent.id,
  friendly_name: 'chief13:Plan',
  runtime_status: { kind: 'ai', status: 'awake', route_state: 'routable' },
}
const sleepingChild = {
  id: 'fleet:sleeping-child',
  parent_agent_id: parent.id,
  friendly_name: 'chief13:Nash',
  runtime_status: { kind: 'ai', status: 'hibernating', route_state: 'no-current-durable-seat' },
}

const activeFamily = projectFleetAgentDirectoryFolding([parent, awakeChild, sleepingChild])
assert.deepEqual(activeFamily.visibleAgents.map(agent => agent.id), [parent.id, awakeChild.id, sleepingChild.id])
assert.equal(activeFamily.foldedParentIds.has(parent.id), false)
assert.equal(activeFamily.childCounts.get(parent.id), 2)

const sleepingFamily = projectFleetAgentDirectoryFolding([parent, sleepingChild])
assert.deepEqual(sleepingFamily.visibleAgents.map(agent => agent.id), [parent.id])
assert.equal(sleepingFamily.foldedParentIds.has(parent.id), true)

const manuallyOpened = projectFleetAgentDirectoryFolding([parent, sleepingChild], { [parent.id]: false })
assert.deepEqual(manuallyOpened.visibleAgents.map(agent => agent.id), [parent.id, sleepingChild.id])

const manuallyFolded = projectFleetAgentDirectoryFolding([parent, awakeChild], { [parent.id]: true })
assert.deepEqual(manuallyFolded.visibleAgents.map(agent => agent.id), [parent.id])

const cyclicParent = { ...parent, id: 'fleet:cyclic-parent', parent_agent_id: 'fleet:cyclic-child' }
const cyclicChild = { ...sleepingChild, id: 'fleet:cyclic-child', parent_agent_id: cyclicParent.id }
const cyclicFamily = projectFleetAgentDirectoryFolding([cyclicParent, cyclicChild])
assert.equal(cyclicFamily.childCounts.get(cyclicParent.id), 1)
assert.equal(cyclicFamily.childCounts.get(cyclicChild.id), 1)

console.log('fleet-agent-directory-model-test: ok')
