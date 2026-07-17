import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import fs from 'fs'

import {
  ACTIVITY_HEALTH_BOUNDARIES,
  ACTIVITY_HEALTH_OK,
  ACTIVITY_HEALTH_UNAVAILABLE,
  activityHealthForProjection,
  activityHealthIncidentDecision,
  activityHealthIncidentPayload,
  formatActivityHealthStatus,
  normalizeActivityHealth,
} from '../shared/activity-health.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { summarizeFleetRosterTruth } from '../server/lib/fleet-roster-truth.mjs'

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-activity-health-'))
  return { store: new FleetStore(path.join(dir, 'fleet.db')), dir }
}

test('activity health formatter distinguishes unavailable from idle', () => {
  const idle = formatActivityHealthStatus(null, { idleText: '' })
  assert.equal(idle, '')

  const health = normalizeActivityHealth({
    state: ACTIVITY_HEALTH_UNAVAILABLE,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.RESOLVE_JSONL_NULL,
    ts: '2026-07-14T11:00:00.000Z',
    lastKnownGoodAt: '2026-07-14T10:55:00.000Z',
  })

  assert.equal(
    formatActivityHealthStatus(health, { nowMs: Date.parse('2026-07-14T11:05:00.000Z') }),
    'unavailable:no jsonl:10m',
  )
})

test('ok activity health carries last-known-good without replacing idle display', () => {
  const health = normalizeActivityHealth({
    state: ACTIVITY_HEALTH_OK,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,
    ts: '2026-07-14T11:00:00.000Z',
  })

  assert.equal(health.lastKnownGoodAt, '2026-07-14T11:00:00.000Z')
  assert.equal(formatActivityHealthStatus(health, { idleText: '' }), '')
})

test('FleetStore persists activity health in agent metadata', () => {
  const { store } = tempStore()
  store.upsertAgent({
    id: 'fleet:agent',
    friendly_name: 'agent',
    tmux_session: 'fleet-agent',
    dead: false,
    metadata: { model: 'gpt-5.5' },
  }, { allowProtectedAgentFields: true })

  const health = normalizeActivityHealth({
    state: ACTIVITY_HEALTH_UNAVAILABLE,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
    reason: 'tmux session fleet-agent is not live',
    ts: '2026-07-14T11:00:00.000Z',
  })
  const result = store.updateAgentActivityHealth('fleet:agent', health)

  assert.equal(result.agent.metadata.model, 'gpt-5.5')
  assert.equal(result.agent.metadata.activityHealth.boundary, ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX)
  assert.equal(store.getAgent('fleet:agent').metadata.activityHealth.reason, 'tmux session fleet-agent is not live')
  store.close()
})

test('fleet roster truth includes activity health for status-line projection', () => {
  const health = normalizeActivityHealth({
    state: ACTIVITY_HEALTH_UNAVAILABLE,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
    ts: '2026-07-14T11:00:00.000Z',
    lastKnownGoodAt: '2026-07-14T10:00:00.000Z',
  })
  const summary = summarizeFleetRosterTruth({
    now: Date.parse('2026-07-14T11:05:00.000Z'),
    roster: [{
      id: 'fleet:agent',
      friendly_name: 'agent',
      runtime_status: { status: 'awake' },
      dead: false,
      human: false,
      metadata: { activityHealth: health },
      labels: [],
    }],
  })

  assert.equal(summary.agents[0].activity_health.boundary, ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX)
})

test('activity health incident payload is keyed by agent and boundary', () => {
  const health = normalizeActivityHealth({
    state: ACTIVITY_HEALTH_UNAVAILABLE,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.RESOLVE_JSONL_NULL,
    reason: 'codex JSONL resolver returned no path',
    ts: '2026-07-14T11:00:00.000Z',
    lastKnownGoodAt: '2026-07-14T10:59:00.000Z',
  })
  const payload = activityHealthIncidentPayload({
    id: 'fleet:agent',
    friendly_name: 'agent',
    machine_id: 'mini',
    env_name: 'prod',
    tmux_session: 'fleet-agent',
  }, health, new Date('2026-07-14T11:05:00.000Z'))

  assert.equal(payload.key, 'fleet:agent:resolve-jsonl-null')
  assert.equal(payload.component, 'activity-health')
  assert.equal(payload.operation, ACTIVITY_HEALTH_BOUNDARIES.RESOLVE_JSONL_NULL)
  assert.equal(payload.evidence.lastKnownGoodAgeMs, 6 * 60_000)
})

test('activity health incident decision dedupes and clears on recovery', () => {
  const agent = { id: 'fleet:agent' }
  const unhealthy = normalizeActivityHealth({
    state: ACTIVITY_HEALTH_UNAVAILABLE,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
    ts: '2026-07-14T11:00:00.000Z',
  })
  const key = 'fleet:agent:no-tmux'

  assert.deepEqual(activityHealthIncidentDecision({}, agent, unhealthy), {
    raise: key,
    clearKeys: [],
  })
  assert.deepEqual(activityHealthIncidentDecision({
    [key]: { key, boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX, clearedAt: null },
  }, agent, unhealthy), {
    raise: null,
    clearKeys: [],
  })

  const recovered = normalizeActivityHealth({
    state: ACTIVITY_HEALTH_OK,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,
    ts: '2026-07-14T11:01:00.000Z',
  })
  assert.deepEqual(activityHealthIncidentDecision({
    [key]: { key, boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX, clearedAt: null },
  }, agent, recovered), {
    raise: null,
    clearKeys: [key],
  })
})

test('activity health recovery is boundary-specific', () => {
  const agent = { id: 'fleet:agent' }
  const watcherKey = 'fleet:agent:no-tmux'
  const runtimeKey = 'fleet:agent:watch-delivery-failed'
  const transportKey = 'fleet:agent:transport-disconnected'
  const incidents = {
    [watcherKey]: { key: watcherKey, boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX, clearedAt: null },
    [runtimeKey]: { key: runtimeKey, boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_DELIVERY_FAILED, clearedAt: null },
    [transportKey]: { key: transportKey, boundary: ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_DISCONNECTED, clearedAt: null },
  }

  assert.deepEqual(activityHealthIncidentDecision(incidents, agent, normalizeActivityHealth({
    state: ACTIVITY_HEALTH_OK,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.LAST_ACTIVITY,
    ts: '2026-07-14T11:01:00.000Z',
  })), {
    raise: null,
    clearKeys: [],
  })

  assert.deepEqual(activityHealthIncidentDecision(incidents, agent, normalizeActivityHealth({
    state: ACTIVITY_HEALTH_OK,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,
    ts: '2026-07-14T11:02:00.000Z',
  })), {
    raise: null,
    clearKeys: [watcherKey, runtimeKey],
  })

  assert.deepEqual(activityHealthIncidentDecision(incidents, agent, normalizeActivityHealth({
    state: ACTIVITY_HEALTH_OK,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_CONNECTED,
    ts: '2026-07-14T11:03:00.000Z',
  })), {
    raise: null,
    clearKeys: [transportKey],
  })
})

test('pending incident reservation suppresses duplicate raises', () => {
  const agent = { id: 'fleet:agent' }
  const key = 'fleet:agent:watch-update-failed'
  const health = normalizeActivityHealth({
    state: ACTIVITY_HEALTH_UNAVAILABLE,
    boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_UPDATE_FAILED,
    ts: '2026-07-14T11:00:00.000Z',
  })

  assert.deepEqual(activityHealthIncidentDecision({
    [key]: { key, boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_UPDATE_FAILED, pending: true, clearedAt: null },
  }, agent, health), {
    raise: null,
    clearKeys: [],
  })
})

test('projection prefers active incidents over latest ok sample', () => {
  const projected = activityHealthForProjection({
    activityHealth: normalizeActivityHealth({
      state: ACTIVITY_HEALTH_OK,
      boundary: ACTIVITY_HEALTH_BOUNDARIES.LAST_ACTIVITY,
      ts: '2026-07-14T11:05:00.000Z',
      lastKnownGoodAt: '2026-07-14T11:05:00.000Z',
    }),
    activityHealthIncidents: {
      'fleet:agent:no-tmux': {
        key: 'fleet:agent:no-tmux',
        boundary: ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
        state: ACTIVITY_HEALTH_UNAVAILABLE,
        raisedAt: '2026-07-14T11:00:00.000Z',
        clearedAt: null,
      },
    },
  })

  assert.equal(projected.state, ACTIVITY_HEALTH_UNAVAILABLE)
  assert.equal(projected.boundary, ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX)
  assert.equal(
    formatActivityHealthStatus(projected, { nowMs: Date.parse('2026-07-14T11:06:00.000Z') }),
    'unavailable:no tmux:60s',
  )
})
