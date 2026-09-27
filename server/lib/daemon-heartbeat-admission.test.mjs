// Daemon-socket heartbeat admission: an owned beat records liveness, a
// foreign one changes nothing. Ownership mirrors never-joined-admission —
// spawn_daemon_key when the row carries it, else the live agent-daemon
// route — and fails closed, so one daemon can never hold another daemon's
// agents alive.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { admitDaemonHeartbeat } from './daemon-heartbeat-admission.mjs'

function liveAgent(overrides = {}) {
  return {
    id: 'fleet:test',
    friendly_name: 'test',
    dead: 0,
    metadata: { spawn_daemon_key: 'mini:testing' },
    ...overrides,
  }
}

function harness({ agent = liveAgent(), route = { agent_id: 'fleet:test', daemon_key: 'mini:testing' }, log = null } = {}) {
  const calls = { heartbeats: [], touched: [], warns: [] }
  const agentRow = agent ? JSON.parse(JSON.stringify(agent)) : null
  const store = {
    getAgent: async id => (agentRow && id === agentRow.id ? agentRow : null),
    getAgentDaemonRoute: async () => route,
    updateHeartbeat: async id => { calls.heartbeats.push(id) },
  }
  const deps = {
    store,
    touchActivity: id => { calls.touched.push(id) },
    log: log || { warn: (...args) => { calls.warns.push(args) } },
  }
  return { deps, calls, agentRow }
}

function beat(overrides = {}) {
  return {
    type: 'heartbeat',
    agent: 'fleet:test',
    daemon_key: 'mini:testing',
    ...overrides,
  }
}

test('owned beat via spawn key records the heartbeat', async () => {
  const { deps, calls } = harness()
  const outcome = await admitDaemonHeartbeat(deps, beat())
  assert.equal(outcome.changed, true)
  assert.equal(outcome.agentId, 'fleet:test')
  assert.deepEqual(calls.heartbeats, ['fleet:test'])
  assert.deepEqual(calls.touched, ['fleet:test'])
})

test('legacy row without spawn key admits via matching route', async () => {
  const agent = liveAgent({ metadata: {} })
  const { deps, calls } = harness({ agent })
  const outcome = await admitDaemonHeartbeat(deps, beat())
  assert.equal(outcome.changed, true)
  assert.deepEqual(calls.heartbeats, ['fleet:test'])
})

test('foreign daemon_key is rejected without effect', async () => {
  const { deps, calls } = harness()
  const outcome = await admitDaemonHeartbeat(deps, beat({ daemon_key: 'air:testing' }))
  assert.equal(outcome.changed, false)
  assert.equal(outcome.ignored, 'ownership')
  assert.deepEqual(calls.heartbeats, [])
  assert.deepEqual(calls.touched, [])
  assert.equal(calls.warns.length, 1)
})

test('legacy row with no route is rejected', async () => {
  const agent = liveAgent({ metadata: {} })
  const { deps, calls } = harness({ agent, route: null })
  const outcome = await admitDaemonHeartbeat(deps, beat())
  assert.equal(outcome.changed, false)
  assert.equal(outcome.ignored, 'ownership')
  assert.deepEqual(calls.heartbeats, [])
})

test('missing claim key is rejected: no key can never verify', async () => {
  const { deps, calls } = harness()
  const outcome = await admitDaemonHeartbeat(deps, beat({ daemon_key: null }))
  assert.equal(outcome.changed, false)
  assert.equal(outcome.ignored, 'ownership')
  assert.deepEqual(calls.heartbeats, [])
})

test('unknown agent is ignored before any ownership read', async () => {
  const { deps, calls } = harness({ agent: null })
  const outcome = await admitDaemonHeartbeat(deps, beat())
  assert.equal(outcome.changed, false)
  assert.equal(outcome.ignored, 'unknown-agent')
  assert.deepEqual(calls.heartbeats, [])
})

test('malformed beats without an agent are ignored', async () => {
  const { deps, calls } = harness()
  const outcome = await admitDaemonHeartbeat(deps, { type: 'heartbeat', daemon_key: 'mini:testing' })
  assert.equal(outcome.changed, false)
  assert.equal(outcome.ignored, 'shape')
  assert.deepEqual(calls.heartbeats, [])
})

test('daemon-convention agent_id field is accepted', async () => {
  const { deps, calls } = harness()
  const outcome = await admitDaemonHeartbeat(deps, { type: 'heartbeat', agent_id: 'fleet:test', daemon_key: 'mini:testing' })
  assert.equal(outcome.changed, true)
  assert.deepEqual(calls.heartbeats, ['fleet:test'])
})

test('a throwing log sink does not turn a rejection into a failure', async () => {
  const { deps } = harness({ log: { warn: () => { throw new Error('sink down') } } })
  const outcome = await admitDaemonHeartbeat(deps, beat({ daemon_key: 'air:testing' }))
  assert.equal(outcome.changed, false)
  assert.equal(outcome.ignored, 'ownership')
})
