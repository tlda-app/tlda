// The roster's `model:` token survived the grammar learning `model:` as its
// own node. Before, `model:muse` parsed as a literal and membership-tested
// against the `model:<value>` label the roster folds onto each row; now it
// parses to `{ t: 'model' }` and the evaluator spells that test out. Same
// rows, including the case fold.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'
import { createFleetRouter } from './fleet.mjs'

const seen = '2026-09-27T20:00:00.000Z'
const row = (id, name, model) => ({
  id, friendly_name: name, labels: [], dead: false, human: false,
  last_seen: seen, registered_at: seen, metadata: { model },
  runtime_status: { kind: 'ai', status: 'awake', activity: 'unknown' },
})

function stubStore() {
  return {
    getFleetTableSnapshot: async () => ({
      roster: [row('fleet:musewriter', 'musewriter', 'muse'), row('fleet:opuswriter', 'opuswriter', 'opus')],
      pendingShells: [],
      wholeFleet: { total: 2, live: 2, dead: 0, byMachine: {} },
    }),
    getDeadAgents: async () => [],
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

async function idsFor(base, filter) {
  const res = await fetch(`${base}/api/fleet-table?filter=${encodeURIComponent(filter)}`)
  assert.equal(res.status, 200)
  const data = await res.json()
  return { matched: data.matched, ids: (data.agents || []).map(a => a.id).sort() }
}

test('roster filter=model:muse still matches the muse row only', async (t) => {
  await withRoute(t, stubStore(), async (base) => {
    assert.deepEqual(await idsFor(base, 'model:muse'), { matched: 1, ids: ['fleet:musewriter'] })
    assert.deepEqual(await idsFor(base, 'model:opus'), { matched: 1, ids: ['fleet:opuswriter'] })
  })
})

test('roster model: still folds case', async (t) => {
  await withRoute(t, stubStore(), async (base) => {
    assert.deepEqual(await idsFor(base, 'model:MUSE'), { matched: 1, ids: ['fleet:musewriter'] })
  })
})

test('roster model: with no holder matches nothing', async (t) => {
  await withRoute(t, stubStore(), async (base) => {
    assert.deepEqual(await idsFor(base, 'model:no-such-model'), { matched: 0, ids: [] })
  })
})

test('CONTROL: bare-name roster matching is unchanged', async (t) => {
  await withRoute(t, stubStore(), async (base) => {
    assert.deepEqual(await idsFor(base, 'musewriter'), { matched: 1, ids: ['fleet:musewriter'] })
  })
})
