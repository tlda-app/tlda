// Dead discovery (tail-11): `/api/fleet-table` unions dead rows into the
// candidate set when — and only when — the caller's filter can match one.
// Unfiltered reads stay the live fleet; `filter=dead` lists the dead.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'
import { createFleetRouter } from './fleet.mjs'

const seen = '2026-09-27T20:00:00.000Z'
const liveRow = {
  id: 'fleet:live', friendly_name: 'live', labels: [], dead: false, human: false,
  last_seen: seen, registered_at: seen, metadata: {},
  runtime_status: { kind: 'ai', status: 'awake', activity: 'unknown' },
}
const deadRow = {
  id: 'fleet:gone', friendly_name: 'gone', labels: [], dead: true, human: false,
  last_seen: seen, registered_at: seen, metadata: {},
  runtime_status: { kind: 'ai', status: 'dead', activity: 'unknown' },
}

function stubStore({ dead = [deadRow] } = {}, calls = []) {
  return {
    calls,
    getFleetTableSnapshot: async () => ({
      roster: [liveRow],
      pendingShells: [],
      wholeFleet: { total: 2, live: 1, dead: 1, byMachine: {} },
    }),
    getDeadAgents: async () => {
      calls.push('getDeadAgents')
      return dead
    },
    resolveAgentQuery: async () => [],
  }
}

async function withRoute(t, fleetStore, fn) {
  const app = express()
  app.use(express.json())
  app.use(createFleetRouter({
    fleetStore,
    broadcastEvent: () => {}, broadcastState: () => {}, clearEphemeralState: () => {}, suppressEchoFor: () => {},
    sendDaemonEphemeral: async () => { throw new Error('unexpected ephemeral RPC') },
    resolveRpc: () => { throw new Error('legacy resolver must not be used') },
    daemonConnections: new Map(),
    resolveSpawnTarget: null,
    enqueueDaemonMessage: () => {},
    requireOperationRead: () => true,
  }))
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('filter=dead lists the dead row with a dead status', async (t) => {
  const store = stubStore()
  await withRoute(t, store, async (base) => {
    const res = await fetch(`${base}/api/fleet-table?filter=${encodeURIComponent('dead')}`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.deepEqual(store.calls, ['getDeadAgents'])
    assert.equal(data.matched, 1)
    assert.equal(data.agents.length, 1)
    assert.equal(data.agents[0].id, 'fleet:gone')
    assert.equal(data.agents[0].status, 'dead')
    assert.equal(data.totals.dead, 1)
  })
})

test('unfiltered fleet-table stays live-only and never reads the dead table', async (t) => {
  const store = stubStore()
  await withRoute(t, store, async (base) => {
    const res = await fetch(`${base}/api/fleet-table`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.deepEqual(store.calls, [])
    assert.ok(data.agents.every(a => a.id !== 'fleet:gone'))
  })
})

test('a negated dead filter does not pay for the dead-table read', async (t) => {
  const store = stubStore()
  await withRoute(t, store, async (base) => {
    const res = await fetch(`${base}/api/fleet-table?filter=${encodeURIComponent('!dead')}`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.deepEqual(store.calls, [])
    assert.equal(data.matched, 1)
    assert.equal(data.agents[0].id, 'fleet:live')
  })
})

test('filter=dead matches a dead human and totals it as dead', async (t) => {
  // The runtime pair projects dead humans as away, so the shared label set
  // carries no 'dead' for them — the roster boundary says it explicitly.
  const deadHuman = {
    id: 'fleet:ex', friendly_name: 'ex', labels: [], dead: true, human: true,
    last_seen: seen, registered_at: seen, metadata: {},
    runtime_status: { kind: 'human', status: 'away', activity: 'unknown' },
  }
  const store = stubStore({ dead: [deadHuman] })
  await withRoute(t, store, async (base) => {
    const res = await fetch(`${base}/api/fleet-table?filter=${encodeURIComponent('dead')}`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.matched, 1)
    assert.equal(data.agents[0].id, 'fleet:ex')
    assert.equal(data.agents[0].status, 'dead')
    assert.equal(data.totals.dead, 1)
    assert.equal(data.totals.hibernating, 0)
  })
})

test('a name filter matching a dead agent returns the row, not resolved_elsewhere', async (t) => {
  // `dead & gone` mentions dead, so the union runs and the name resolves to
  // a row. (A bare-name sweep across the dead table is deliberately NOT the
  // shape: the union is gated on the filter naming death.)
  const store = stubStore()
  await withRoute(t, store, async (base) => {
    const res = await fetch(`${base}/api/fleet-table?filter=${encodeURIComponent('dead & gone')}`)
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.deepEqual(store.calls, ['getDeadAgents'])
    assert.equal(data.matched, 1)
    assert.equal(data.agents[0].id, 'fleet:gone')
    assert.deepEqual(data.resolved_elsewhere, [])
  })
})
