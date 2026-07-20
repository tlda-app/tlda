import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LIVENESS,
  ROUTE_STATE,
  createAgentRuntimeStatusStore,
  projectAgentRuntimeStatus,
} from '../server/lib/agent-runtime-status.mjs'

const seat = {
  agent_id: 'fleet:a',
  daemon_key: 'mini:prod',
  session_id: 'session-a',
  tmux_session: 'fleet-a',
}

test('positive runtime evidence does not manufacture hibernation from elapsed time', () => {
  const base = { id: 'fleet:a', dead: false, human: false, metadata: {} }
  const evidence = {
    liveness: LIVENESS.ALIVE,
    liveness_source: 'daemon-hosted-session-refresh',
    liveness_at_ms: 1_000,
    liveness_at: new Date(1_000).toISOString(),
  }

  assert.equal(projectAgentRuntimeStatus(base, evidence, {
    nowMs: 91_000,
    ttlMs: 90_000,
    seat,
    isDaemonConnected: () => true,
  }).status, 'awake')

  const expired = projectAgentRuntimeStatus(base, evidence, {
    nowMs: 91_001,
    ttlMs: 90_000,
    seat,
    isDaemonConnected: () => true,
  })
  assert.equal(expired.status, 'awake')
  assert.equal(expired.reason, 'daemon-hosted-session-refresh')
})

test('explicit dead or wedged evidence wins immediately', () => {
  const base = { id: 'fleet:a', dead: false, human: false, metadata: {} }
  for (const liveness of [LIVENESS.DEAD, LIVENESS.WEDGED]) {
    const projection = projectAgentRuntimeStatus(base, {
      liveness,
      liveness_source: 'daemon-agent-liveness',
      liveness_reason: `${liveness} now`,
      liveness_at_ms: 1_000,
    }, {
      nowMs: 1_100,
      ttlMs: 90_000,
      seat,
      isDaemonConnected: () => true,
    })
    assert.equal(projection.status, 'hibernating')
    assert.equal(projection.reason, `${liveness} now`)
  }
})

test('daemon disconnect changes route state without erasing positive status before expiry', () => {
  const base = { id: 'fleet:a', dead: false, human: false, metadata: {} }
  const projection = projectAgentRuntimeStatus(base, {
    liveness: LIVENESS.ALIVE,
    liveness_source: 'daemon-hosted-session-refresh',
    liveness_at_ms: 1_000,
  }, {
    nowMs: 5_000,
    ttlMs: 90_000,
    seat,
    isDaemonConnected: () => false,
  })
  assert.equal(projection.status, 'awake')
  assert.equal(projection.route_state, ROUTE_STATE.DAEMON_DISCONNECTED)
})

test('runtime status store reports route state from exact current seat', () => {
  let now = 1_000
  const store = createAgentRuntimeStatusStore({
    now: () => now,
    getSeat: () => seat,
    isDaemonConnected: key => key === 'mini:prod',
  })
  store.markAlive('fleet:a', 'test-refresh')
  const projection = store.project({ id: 'fleet:a', dead: false, human: false, metadata: {} })
  assert.equal(projection.status, 'awake')
  assert.equal(projection.route_state, ROUTE_STATE.ROUTABLE)
  now += 91_000
  assert.equal(store.project({ id: 'fleet:a', dead: false, human: false, metadata: {} }).status, 'awake')
})

test('a routable current seat is awake until explicit negative liveness arrives', () => {
  const base = { id: 'fleet:a', dead: false, human: false, metadata: {} }
  const projection = projectAgentRuntimeStatus(base, null, {
    nowMs: 5_000,
    seat,
    isDaemonConnected: () => true,
  })
  assert.equal(projection.status, 'awake')
  assert.equal(projection.reason, 'current-seat-routable-no-negative-evidence')
})

test('canonical runtime evidence tracks one continuous alive interval', () => {
  let now = 1_000
  const store = createAgentRuntimeStatusStore({ now: () => now, ttlMs: 90_000 })
  store.markAlive('fleet:a', 'first')
  assert.equal(store.evidenceFor('fleet:a').alive_since_ms, 1_000)

  now = 60_000
  store.markAlive('fleet:a', 'refresh')
  assert.equal(store.evidenceFor('fleet:a').alive_since_ms, 1_000)

  store.markAlive('fleet:a', 'older-backfill', { atMs: 30_000 })
  assert.equal(store.evidenceFor('fleet:a').alive_since_ms, 1_000)
  assert.equal(store.evidenceFor('fleet:a').liveness_at_ms, 60_000)

  store.markNotAlive('fleet:a', 'hibernate')
  assert.equal(store.evidenceFor('fleet:a').alive_since_ms, null)

  now = 70_000
  store.markAlive('fleet:a', 'wake')
  assert.equal(store.evidenceFor('fleet:a').alive_since_ms, 70_000)
})
