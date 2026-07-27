import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeFleetRosterTruth } from '../server/lib/fleet-roster-truth.mjs'
import { runtimeStatusForAgent } from '../shared/fleet-runtime-status.mjs'

test('runtimeStatusForAgent reads plain row status instead of fabricating hibernating', () => {
  const row = {
    id: 'fleet:shell',
    status: 'shell',
    activity: 'tool_call',
  }

  assert.equal(runtimeStatusForAgent(row).status, 'shell')
})

test('runtimeStatusForAgent returns unknown for an unstamped row with no status evidence', () => {
  assert.equal(runtimeStatusForAgent({ id: 'fleet:unstamped' }).status, 'unknown')
})

test('fleet-table summary rows preserve hydrated runtime_status', () => {
  const runtimeStatus = {
    status: 'unavailable',
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

  assert.equal(summary.agents[0].status, 'unavailable')
  assert.deepEqual(summary.agents[0].runtime_status, runtimeStatus)
})
