import assert from 'node:assert/strict'

import {
  ACTIVITY_HEALTH_BOUNDARIES,
  ACTIVITY_HEALTH_OK,
  ACTIVITY_HEALTH_UNAVAILABLE,
  activityHealthForProjection,
  activityHealthKey,
} from '../shared/activity-health.mjs'

const agentId = 'fleet:projection-test'
const staleWatchFailureKey = activityHealthKey(agentId, ACTIVITY_HEALTH_BOUNDARIES.WATCH_CREATE_FAILED)

const staleWatchFailureIncident = {
  key: staleWatchFailureKey,
  boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_CREATE_FAILED,
  state: ACTIVITY_HEALTH_UNAVAILABLE,
  raisedAt: '2026-07-24T18:03:00.000Z',
  clearedAt: null,
}

const laterConnectedHealth = {
  state: ACTIVITY_HEALTH_OK,
  boundary: ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_CONNECTED,
  reason: 'daemon websocket connected',
  ts: '2026-07-24T19:04:00.000Z',
  lastKnownGoodAt: '2026-07-24T19:04:00.000Z',
}

const recoveredProjection = activityHealthForProjection({
  activityHealth: laterConnectedHealth,
  activityHealthIncidents: {
    [staleWatchFailureKey]: staleWatchFailureIncident,
  },
})

assert.equal(recoveredProjection.state, ACTIVITY_HEALTH_OK)
assert.equal(recoveredProjection.boundary, ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_CONNECTED)
assert.equal(recoveredProjection.reason, 'daemon websocket connected')

const newerFailureIncident = {
  ...staleWatchFailureIncident,
  raisedAt: '2026-07-24T20:04:00.000Z',
}

const failedProjection = activityHealthForProjection({
  activityHealth: laterConnectedHealth,
  activityHealthIncidents: {
    [staleWatchFailureKey]: newerFailureIncident,
  },
})

assert.equal(failedProjection.state, ACTIVITY_HEALTH_UNAVAILABLE)
assert.equal(failedProjection.boundary, ACTIVITY_HEALTH_BOUNDARIES.WATCH_CREATE_FAILED)
assert.equal(failedProjection.ts, newerFailureIncident.raisedAt)

console.log('activity-health-projection-test: ok')
