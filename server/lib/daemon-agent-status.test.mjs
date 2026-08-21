import assert from 'node:assert/strict'
import test from 'node:test'

import { validateDaemonAgentStatusBatch } from './daemon-agent-status.mjs'
import { createAgentRuntimeStatusStore } from './agent-runtime-status.mjs'

const agent = { id: 'fleet:owned', route_daemon_key: 'mini:testing' }
const message = {
  daemon_key: 'mini:testing',
  daemon_boot_id: 7,
  report_seq: 2,
  snapshot_complete: true,
  agents: [{ agent_id: 'fleet:owned', status: 'awake', activity: 'thinking', tool: null }],
}

test('accepts only a newer complete batch owned by the socket daemon', () => {
  assert.deepEqual(validateDaemonAgentStatusBatch({
    message,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    agents: [agent],
  }), { sequence: 2, results: message.agents })

  assert.equal(validateDaemonAgentStatusBatch({
    message,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 2,
    agents: [agent],
  }), null)

  assert.equal(validateDaemonAgentStatusBatch({
    message,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    agents: [{ ...agent, route_daemon_key: 'mini:stable' }],
  }), null)
})

test('activity rejects a stale generation from the same daemon boot', () => {
  const runtime = createAgentRuntimeStatusStore({ now: () => 100 })
  runtime.updateActivity('fleet:owned', 'thinking', {
    tool: null,
    atMs: 100,
    generation: { daemon_key: 'mini:testing', daemon_boot_id: 7, report_seq: 3 },
  })
  runtime.updateActivity('fleet:owned', 'idle', {
    tool: null,
    atMs: 101,
    generation: { daemon_key: 'mini:testing', daemon_boot_id: 7, report_seq: 2 },
  })
  assert.equal(runtime.evidenceFor('fleet:owned').activity, 'thinking')
})
