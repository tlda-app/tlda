import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentRuntimeStatusStore } from '../server/lib/agent-runtime-status.mjs'
import { summarizeFleetRosterTruth } from '../server/lib/fleet-roster-truth.mjs'
import { runtimeStatusForAgent } from '../shared/fleet-runtime-status.mjs'

test('runtimeStatusForAgent preserves a valid discriminated state', () => {
  const state = { kind: 'human', status: 'here', activity: 'viewing' }
  assert.deepEqual(runtimeStatusForAgent({
    id: 'fleet:skip',
    human: true,
    runtime_status: state,
  }), state)
})

test('runtimeStatusForAgent rejects invalid kind/status pairs', () => {
  assert.throws(
    () => runtimeStatusForAgent({
      id: 'fleet:skip',
      human: true,
      runtime_status: { kind: 'human', status: 'awake' },
    }),
    /human→here\|away/,
  )
  assert.throws(
    () => runtimeStatusForAgent({
      id: 'fleet:agent',
      runtime_status: { kind: 'ai', status: 'away' },
    }),
    /ai→awake\|hibernating\|dead/,
  )
})

test('unstamped rows get a valid kind-specific conservative state', () => {
  assert.deepEqual(
    runtimeStatusForAgent({ id: 'fleet:human', human: true }),
    { kind: 'human', status: 'away', activity: 'unknown', reason: null },
  )
  assert.deepEqual(
    runtimeStatusForAgent({ id: 'fleet:ai' }),
    { kind: 'ai', status: 'hibernating', activity: 'unknown', reason: null },
  )
})

test('human projection follows explicit browser presence, not last_seen age', () => {
  let now = Date.parse('2026-07-28T12:00:00.000Z')
  const store = createAgentRuntimeStatusStore({ now: () => now })
  const human = {
    id: 'fleet:skip',
    human: true,
    last_seen: '1999-01-01T00:00:00.000Z',
  }

  assert.deepEqual(
    { kind: store.project(human).kind, status: store.project(human).status },
    { kind: 'human', status: 'away' },
  )
  store.markHumanPresence(human.id, 'here', 'browser-connections-0-to-1', { atMs: now })
  assert.deepEqual(
    { kind: store.project(human).kind, status: store.project(human).status },
    { kind: 'human', status: 'here' },
  )
  now += 24 * 60 * 60 * 1000
  assert.equal(store.project(human).status, 'here')
  store.markHumanPresence(human.id, 'away', 'browser-connections-1-to-0', { atMs: now })
  assert.equal(store.project(human).status, 'away')
})

test('repeated liveness evidence updates authority without broadcasting unchanged status', () => {
  let now = Date.parse('2026-07-28T12:00:00.000Z')
  const changed = []
  const store = createAgentRuntimeStatusStore({
    now: () => now,
    onChange: agentId => changed.push(agentId),
  })

  store.markAlive('fleet:agent', 'snapshot', { atMs: now, report_seq: 1 })
  now += 30_000
  store.markAlive('fleet:agent', 'snapshot', { atMs: now, report_seq: 2 })
  assert.deepEqual(changed, ['fleet:agent'])
  assert.equal(store.evidenceFor('fleet:agent').liveness_report_seq, 2)

  now += 30_000
  store.markNotAlive('fleet:agent', 'snapshot', { atMs: now, report_seq: 3 })
  now += 30_000
  store.markNotAlive('fleet:agent', 'snapshot', { atMs: now, report_seq: 4 })
  assert.deepEqual(changed, ['fleet:agent', 'fleet:agent'])
  assert.equal(store.evidenceFor('fleet:agent').liveness_report_seq, 4)
})

test('fleet-table summary rows preserve hydrated runtime_status', () => {
  const runtimeStatus = {
    kind: 'ai',
    status: 'hibernating',
    route: { daemon_key: 'mini:testing' },
    route_state: 'daemon-disconnected',
    route_reason: 'daemon-disconnected',
  }
  const agent = {
    id: 'fleet:unavailable',
    friendly_name: 'unavailable-agent',
    runtime_status: runtimeStatus,
    metadata: {},
  }

  const summary = summarizeFleetRosterTruth({
    roster: [agent],
    matched: [agent],
    limit: 1,
    now: Date.now(),
  })

  assert.equal(summary.agents[0].status, 'hibernating')
  assert.deepEqual(summary.agents[0].runtime_status, runtimeStatus)
})
