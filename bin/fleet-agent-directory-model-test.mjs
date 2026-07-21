import assert from 'node:assert/strict'

import {
  fleetAgentCategory,
  formatFleetAgentActivityHealthForAgent,
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
}

assert.equal(fleetAgentCategory(human), 'awake')
assert.equal(formatFleetAgentActivityHealthForAgent(human), '')
const humanRow = toFleetAgentDirectoryRow(human)
assert.equal(humanRow.activityHealth, '')
assert.equal(humanRow.notResumable, false)
assert(!humanRow.hoverTitle.includes('tmux'))
assert(!humanRow.hoverTitle.includes('no-tmux'))
assert(!humanRow.hoverTitle.includes('not resumable'))

const routableAgent = {
  id: 'fleet:routable-agent',
  friendly_name: 'routable-agent',
  human: false,
  dead: false,
  metadata: { activityHealth: staleNoTmux },
  runtime_status: { route_state: 'routable' },
  session_id: 'session-routable-agent',
  resume_id: 'session-routable-agent',
}

assert.equal(formatFleetAgentActivityHealthForAgent(routableAgent), '')
assert.equal(toFleetAgentDirectoryRow(routableAgent).activityHealth, '')

const disconnectedAgent = {
  ...routableAgent,
  runtime_status: { route_state: 'daemon-disconnected' },
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

console.log('fleet-agent-directory-model-test: ok')
