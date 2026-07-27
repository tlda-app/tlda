#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createAgentLiveness, livenessAgentsFromProcessBindings } from '../daemon/agent-liveness.mjs'
import { createAgentRuntimeStatusStore } from '../server/lib/agent-runtime-status.mjs'
import { daemonEventSeatDecision } from '../server/lib/daemon-event-route-authority.mjs'
import {
  agentLivenessTraceResponse,
  createAgentLivenessTraceStore,
  recordLivenessProjection,
} from '../server/lib/agent-liveness-trace.mjs'

const sent = []
const reporter = createAgentLiveness({
  daemonKey: 'mini:default',
  daemonBootId: 42,
  getAgents: () => [
    { id: 'alive', tmux_session: 's1' },
    { id: 'not-alive', tmux_session: 's2' },
  ],
  listSessions: async () => ({ sessions: ['s1'] }),
  sendMsg: message => sent.push(message),
})
await reporter.reportHostedSessions('test')
await reporter.reportHostedSessions('test-again')
// The report describes what is RUNNING, and separately names locally hosted
// sessions that were affirmatively absent from a successful tmux inventory.
assert.equal(sent[0].type, 'agent-liveness-snapshot')
assert.deepEqual(sent[0].running_agent_ids, ['alive'])
assert.deepEqual(sent[0].absent_agent_ids, ['not-alive'])
assert.equal(sent[0].snapshot_complete, true)
assert.equal('checked_agent_ids' in sent[0], false)
assert.equal('liveness_generations' in sent[0], false)
assert.equal(sent[1].report_seq, 2)

const localBindings = [
  { id: 'local-agent', daemonKey: 'mini:default', tmuxSession: 'local-session' },
  { id: 'other-environment', daemonKey: 'mini:other', tmuxSession: 'other-session' },
]
const localReports = []
let intervalToken = null
let clearedToken = null
const lifecycleReporter = createAgentLiveness({
  daemonKey: 'mini:default',
  daemonBootId: 43,
  getAgents: () => livenessAgentsFromProcessBindings(localBindings, { daemonKey: 'mini:default' }),
  listSessions: async () => ({ sessions: ['local-session'] }),
  sendMsg: message => localReports.push(message),
  setIntervalFn: callback => { intervalToken = { callback, unref() {} }; return intervalToken },
  clearIntervalFn: token => { clearedToken = token },
})
await lifecycleReporter.start()
assert.deepEqual(localReports[0].running_agent_ids, ['local-agent'])
assert.deepEqual(localReports[0].absent_agent_ids, [])
assert.equal(localReports[0].report_seq, 1)
lifecycleReporter.stop()
assert.equal(clearedToken, intervalToken)
await lifecycleReporter.start()
assert.deepEqual(localReports[1].running_agent_ids, ['local-agent'])
assert.deepEqual(localReports[1].absent_agent_ids, [])
assert.equal(localReports[1].report_seq, 2)

const seat = { daemon_key: 'mini:default', terminal_capability: 'redacted-in-diagnostics' }
const fleetStore = { getCurrentAgentSeat: id => id === 'known' ? seat : null }
assert.deepEqual(daemonEventSeatDecision(fleetStore, { agentId: 'known', daemonKey: 'mini:default' }), {
  seat, accepted: true, rejection_reason: null,
})
assert.equal(daemonEventSeatDecision(fleetStore, { agentId: 'known', daemonKey: 'other' }).rejection_reason, 'daemon-key-mismatch')
assert.equal(daemonEventSeatDecision(fleetStore, { agentId: 'missing', daemonKey: 'mini:default' }).rejection_reason, 'no-current-seat')

let nowMs = 1_000
const runtime = createAgentRuntimeStatusStore({
  now: () => nowMs,
  getSeat: () => seat,
  isDaemonConnected: () => true,
})
const generation = { daemon_key: 'mini:default', daemon_boot_id: 42, report_seq: 7, agent_id: 'known' }
runtime.markAlive('known', 'daemon-hosted-session-refresh', {
  atMs: nowMs,
  liveness_generation: generation,
  daemon_key: generation.daemon_key,
  daemon_boot_id: generation.daemon_boot_id,
  report_seq: generation.report_seq,
})
let projected = runtime.project({ id: 'known', metadata: {} })
assert.equal(projected.status, 'awake')
assert.deepEqual(projected.evidence.liveness_generation, generation)
runtime.markNotAlive('known', 'daemon-hosted-session-refresh', {
  atMs: ++nowMs,
  liveness_generation: generation,
  daemon_key: generation.daemon_key,
  daemon_boot_id: generation.daemon_boot_id,
  report_seq: generation.report_seq,
})
projected = runtime.project({ id: 'known', metadata: {} })
assert.equal(projected.status, 'hibernating')
assert.deepEqual(projected.evidence.liveness_generation, generation)

// The batch decision path (decideAgentLivenessBatch / recordLivenessIngress) and
// its per-agent ingress trace were deleted with the 378-agent walk they served.
// The daemon now sends a complete running-process snapshot and the server
// replaces its list, so there is no per-agent accept/reject decision to trace.
// Snapshot emission is asserted at the top of this file; the seat-ownership rule
// it still relies on is asserted above via daemonEventSeatDecision.

// recordLivenessProjection is still live -- _broadcastStateNow uses it -- so it
// keeps its coverage, now with a locally-built store and generation instead of
// borrowing them from the deleted batch path.
const trace = createAgentLivenessTraceStore({ generationsPerAgent: 2, eventsPerGeneration: 8, now: () => '2026-07-21T21:00:01.000Z' })
const projectionGeneration = { daemon_key: 'mini:default', daemon_boot_id: 42, report_seq: 1, agent_id: 'alive' }
trace.record({ agent_id: 'alive', generation: projectionGeneration, stage: 'runtime.markAlive' })
for (let index = 0; index < 12; index += 1) {
  recordLivenessProjection(trace, {
    agentId: 'alive',
    generation: projectionGeneration,
    runtime: { status: 'awake', reason: `projection-${index}`, route_reason: 'current-seat-routable', evidence: { liveness: 'alive', liveness_source: 'daemon-hosted-session-refresh', liveness_at: '2026-07-21T21:00:00.000Z' } },
    changedRowBuilt: index === 11,
  })
}
assert.deepEqual(trace.list('alive').map(entry => entry.stage), [
  'runtime.markAlive', 'runtime.projected', 'agentsDelta.changedRowBuilt',
])
assert.equal(trace.list('alive').find(entry => entry.stage === 'runtime.projected').reason, 'projection-11')

const isolated = createAgentLivenessTraceStore({ generationsPerAgent: 2, eventsPerGeneration: 3 })
const targetGeneration = { daemon_key: 'mini:default', daemon_boot_id: 42, report_seq: 1, agent_id: 'target' }
isolated.record({ agent_id: 'target', generation: targetGeneration, stage: 'server.received' })
for (let index = 0; index < 20; index += 1) {
  const otherGeneration = { daemon_key: 'mini:default', daemon_boot_id: 42, report_seq: index, agent_id: 'other' }
  isolated.record({ agent_id: 'other', generation: otherGeneration, stage: 'server.received' })
}
assert.equal(isolated.list('target')[0].generation.report_seq, 1)
assert.equal(isolated.generationCount('other'), 2)
for (let index = 0; index < 6; index += 1) isolated.record({ agent_id: 'target', generation: targetGeneration, stage: `event-${index}` })
assert.equal(isolated.list('target').length, 3)

const projectionTrace = createAgentLivenessTraceStore()
recordLivenessProjection(projectionTrace, { agentId: 'known', generation, runtime: projected, changedRowBuilt: true })
recordLivenessProjection(projectionTrace, { agentId: 'known', generation, runtime: projected, changedRowBuilt: false })
assert.deepEqual(projectionTrace.list('known').map(entry => entry.stage), [
  'runtime.projected', 'agentsDelta.changedRowNotBuilt',
])
assert.equal(projectionTrace.list('known')[1].changed_row_generation.report_seq, generation.report_seq)

projectionTrace.record({
  agent_id: 'known', generation, stage: 'forbidden-probe',
  session_id: 'secret', resume_handle: 'secret', tmux_session: 'secret', terminal_capability: 'secret', capability: 'secret',
})
const response = agentLivenessTraceResponse(projectionTrace, { agent: 'known', limit: 100 })
assert.equal(response.ok, true)
assert.equal(response.agent, 'known')
assert.equal(response.traces.some(entry => ['session_id', 'resume_handle', 'tmux_session', 'terminal_capability', 'capability'].some(key => key in entry)), false)

const here = dirname(fileURLToPath(import.meta.url))
const serverSource = fs.readFileSync(resolve(here, '../server/unified-server.mjs'), 'utf8')
assert.match(serverSource, /app\.get\('\/api\/diagnostics\/agent-liveness-trace', requireRead/)
assert.match(serverSource, /res\.json\(agentLivenessTraceResponse/)

console.log('agent-liveness trace tests passed')
