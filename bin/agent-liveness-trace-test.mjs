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
  decideAgentLivenessBatch,
  recordLivenessIngress,
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
assert.deepEqual(sent[0].agent_ids, ['alive'])
assert.deepEqual(sent[0].checked_agent_ids, ['alive', 'not-alive'])
assert.deepEqual(sent[0].liveness_generations, [
  { daemon_key: 'mini:default', daemon_boot_id: 42, report_seq: 1, agent_id: 'alive' },
  { daemon_key: 'mini:default', daemon_boot_id: 42, report_seq: 1, agent_id: 'not-alive' },
])
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
assert.deepEqual(localReports[0].checked_agent_ids, ['local-agent'])
assert.equal(localReports[0].liveness_generations[0].report_seq, 1)
lifecycleReporter.stop()
assert.equal(clearedToken, intervalToken)
await lifecycleReporter.start()
assert.deepEqual(localReports[1].checked_agent_ids, ['local-agent'])
assert.equal(localReports[1].liveness_generations[0].report_seq, 2)

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
assert.equal(projected.status, 'unavailable')
assert.deepEqual(projected.evidence.liveness_generation, generation)

function decisionsFor(message, seats = {}) {
  return decideAgentLivenessBatch({
    message,
    socketDaemonKey: 'mini:default',
    socketBootId: 42,
    seatForAgent: agentId => daemonEventSeatDecision({
      getCurrentAgentSeat: () => seats[agentId] || null,
    }, { agentId, daemonKey: 'mini:default', log: null }),
  })
}

const batchMessage = {
  agent_ids: ['alive'],
  checked_agent_ids: ['alive', 'not-alive'],
  daemon_key: 'mini:default',
  daemon_boot_id: 42,
  report_seq: 9,
  reported_at: '2026-07-21T21:00:00.000Z',
  session_id: 'daemon-supplied-session-must-not-affect-authority',
}
const accepted = decisionsFor(batchMessage, { alive: seat, 'not-alive': seat })
assert.deepEqual(accepted.map(item => item.terminal_decision), ['accepted-alive', 'accepted-not-alive'])
assert.equal(accepted.every(item => item.seat_identity_match === true), true)
assert.equal(new Set(accepted.map(item => item.agent_id)).size, batchMessage.checked_agent_ids.length)

const rejectionCases = [
  [{ ...batchMessage, checked_agent_ids: ['key'], agent_ids: [], daemon_key: 'other' }, {}, 'daemon-key-mismatch'],
  [{ ...batchMessage, checked_agent_ids: ['boot'], agent_ids: [], daemon_boot_id: 41 }, {}, 'daemon-boot-mismatch'],
  // An ALIVE claim for an agent this daemon holds no seat for is still rejected:
  // accepting it would let one daemon keep another daemon's agent looking awake.
  [{ ...batchMessage, checked_agent_ids: ['none'], agent_ids: ['none'] }, {}, 'no-current-seat'],
  // A seat owned by ANOTHER daemon rejects in BOTH directions — this daemon is
  // the authority on its own box only.
  [{ ...batchMessage, checked_agent_ids: ['elsewhere'], agent_ids: [] }, { elsewhere: { ...seat, daemon_key: 'other:default' } }, 'daemon-key-mismatch'],
]
for (const [message, seats, expected] of rejectionCases) {
  const [decision] = decisionsFor(message, seats)
  assert.equal(decision.terminal_decision, 'rejected')
  assert.equal(decision.rejection_reason, expected)
}

// A "session is gone" report for an agent with NO current seat is accepted
// without ownership proof. The daemon is the authority on what runs on its box,
// and this report is the only thing that ever clears such an agent — discarding
// it is what left ~190 dead agents being re-checked every 30s forever.
const [unseatedDeath] = decisionsFor({ ...batchMessage, checked_agent_ids: ['gone'], agent_ids: [] }, {})
assert.equal(unseatedDeath.terminal_decision, 'accepted-not-alive-unseated')
assert.equal(unseatedDeath.accepted, true)
assert.equal(unseatedDeath.alive, false)
assert.equal(unseatedDeath.rejection_reason, null)
const [missingInput] = decideAgentLivenessBatch({
  message: { ...batchMessage, checked_agent_ids: ['missing-input'], agent_ids: [], report_seq: null },
  socketDaemonKey: 'mini:default',
  socketBootId: 42,
  seatForAgent: () => { throw new Error('missing input must reject before seat lookup') },
})
assert.equal(missingInput.rejection_reason, 'missing-input')

const trace = createAgentLivenessTraceStore({ generationsPerAgent: 2, eventsPerGeneration: 8, now: () => '2026-07-21T21:00:01.000Z' })
for (const decision of accepted) {
  recordLivenessIngress(trace, decision, batchMessage, {
    socketDaemonKey: 'mini:default', socketBootId: 42, receivedAt: '2026-07-21T21:00:00.500Z',
  })
  trace.record({
    agent_id: decision.agent_id,
    generation: decision.generation,
    stage: decision.alive ? 'runtime.markAlive' : 'runtime.markNotAlive',
    terminal_decision: decision.terminal_decision,
  })
}
assert.deepEqual(trace.list('alive').map(entry => entry.stage), [
  'daemon.report.emitted', 'server.received', 'seat.accepted', 'runtime.markAlive',
])
assert.deepEqual(trace.list('not-alive').map(entry => entry.stage), [
  'daemon.report.emitted', 'server.received', 'seat.accepted', 'runtime.markNotAlive',
])
for (const agentId of ['alive', 'not-alive']) {
  assert.equal(trace.list(agentId).filter(entry => entry.terminal_decision).length, 1)
}

const [bootRejected] = decisionsFor(rejectionCases[1][0], {})
recordLivenessIngress(trace, bootRejected, rejectionCases[1][0], { socketDaemonKey: 'mini:default', socketBootId: 42 })
assert.deepEqual(trace.list('boot').map(entry => entry.stage), ['daemon.report.emitted', 'server.received', 'seat.rejected'])
assert.equal(trace.list('boot').filter(entry => entry.terminal_decision).length, 1)

for (let index = 0; index < 12; index += 1) {
  recordLivenessProjection(trace, {
    agentId: 'alive',
    generation: accepted[0].generation,
    runtime: { status: 'awake', reason: `projection-${index}`, route_reason: 'current-seat-routable', evidence: { liveness: 'alive', liveness_source: 'daemon-hosted-session-refresh', liveness_at: '2026-07-21T21:00:00.000Z' } },
    changedRowBuilt: index === 11,
  })
}
assert.deepEqual(trace.list('alive').map(entry => entry.stage), [
  'daemon.report.emitted', 'server.received', 'seat.accepted', 'runtime.markAlive',
  'runtime.projected', 'agentsDelta.changedRowBuilt',
])
assert.equal(trace.list('alive').find(entry => entry.stage === 'runtime.projected').reason, 'projection-11')
assert.equal(trace.list('alive').filter(entry => entry.terminal_decision).length, 1)

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
