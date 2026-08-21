import assert from 'node:assert/strict'
import test from 'node:test'

import { applyDaemonAgentStatusBatch, validateDaemonAgentStatusBatch } from './daemon-agent-status.mjs'
import { createAgentRuntimeStatusStore } from './agent-runtime-status.mjs'

const agent = { id: 'fleet:owned', route_daemon_key: 'mini:testing' }
const omittedAgent = { id: 'fleet:omitted', route_daemon_key: 'mini:testing' }
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
    agents: [agent, omittedAgent],
  }), {
    sequence: 2,
    results: [
      ...message.agents,
      { agent_id: 'fleet:omitted', status: 'hibernating', activity: 'unknown', tool: null },
    ],
  })

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

test('an empty complete batch hibernates every routed agent', () => {
  const empty = { ...message, agents: [] }
  assert.deepEqual(validateDaemonAgentStatusBatch({
    message: empty,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    agents: [agent, omittedAgent],
  }), {
    sequence: 2,
    results: [
      { agent_id: 'fleet:owned', status: 'hibernating', activity: 'unknown', tool: null },
      { agent_id: 'fleet:omitted', status: 'hibernating', activity: 'unknown', tool: null },
    ],
  })
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

test('a later batch cannot apply until the prior batch finishes', async () => {
  const chains = new Map()
  const events = []
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const first = applyDaemonAgentStatusBatch(chains, 'mini:testing', async () => {
    events.push('first-start')
    await firstGate
    events.push('first-end')
  })
  const second = applyDaemonAgentStatusBatch(chains, 'mini:testing', async () => {
    events.push('second-start')
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['first-start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start'])
  assert.equal(chains.size, 0)
})

test('an old boot queued after takeover has no side effects', async () => {
  const chains = new Map()
  const events = []
  const newSocket = { boot: 8 }
  const oldSocket = { boot: 7 }
  const activeSocket = newSocket
  let releaseNew
  const newGate = new Promise(resolve => { releaseNew = resolve })
  const current = applyDaemonAgentStatusBatch(chains, 'mini:testing', async () => {
    events.push('new-start')
    await newGate
    events.push('new-end')
  }, () => activeSocket === newSocket)
  const superseded = applyDaemonAgentStatusBatch(chains, 'mini:testing', async () => {
    events.push('old-applied')
  }, () => activeSocket === oldSocket)

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['new-start'])
  releaseNew()
  await Promise.all([current, superseded])
  assert.deepEqual(events, ['new-start', 'new-end'])
  assert.equal(chains.size, 0)
})
