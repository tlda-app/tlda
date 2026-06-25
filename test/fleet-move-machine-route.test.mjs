import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'

import { createFleetRouter } from '../server/routes/fleet.mjs'

async function withServer(deps, fn) {
  const app = express()
  app.use(express.json())
  app.use(createFleetRouter({
    broadcastEvent: () => {},
    clearEphemeralState: () => {},
    suppressEchoFor: () => {},
    sendRpc: async () => ({}),
    resolveRpc: () => ({ via: 'none', code: 503, error: 'unused' }),
    resolveSpawnTarget: null,
    ...deps,
  }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function moveStore(agent) {
  const calls = { upsert: [], share: [] }
  return {
    calls,
    findAgent(query) {
      return query === agent.id || query === agent.friendly_name ? agent : null
    },
    upsertAgent(next) {
      calls.upsert.push(next)
      Object.assign(agent, next)
    },
    async share(event) {
      calls.share.push(event)
      return { id: 42, ...event }
    },
  }
}

async function postJson(base, body) {
  const res = await fetch(`${base}/api/agents/move-machine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  return { status: res.status, json }
}

test('move-machine refuses when expected source does not match current agent machine', async () => {
  const agent = { id: 'fleet:a', friendly_name: 'alpha', machine_id: 'air', dead: false }
  await withServer({
    fleetStore: moveStore(agent),
    daemonConnections: new Map([['mini', { readyState: 1 }]]),
    broadcastState: () => {},
  }, async base => {
    const res = await postJson(base, {
      agent: 'alpha',
      machine_id: 'mini',
      expected_from: 'wrong',
    })
    assert.equal(res.status, 409)
    assert.match(res.json.error, /belongs to air/)
  })
})

test('move-machine refuses when destination daemon is not connected', async () => {
  const agent = { id: 'fleet:a', friendly_name: 'alpha', machine_id: 'air', dead: false }
  await withServer({
    fleetStore: moveStore(agent),
    daemonConnections: new Map(),
    broadcastState: () => {},
  }, async base => {
    const res = await postJson(base, {
      agent: 'alpha',
      machine_id: 'mini',
      expected_from: 'air',
    })
    assert.equal(res.status, 503)
    assert.match(res.json.error, /no fleet-daemon connected/)
  })
})

test('move-machine switches machine_id and refreshes daemon agent lists', async () => {
  const agent = { id: 'fleet:a', friendly_name: 'alpha', machine_id: 'air', dead: false, metadata: { kind: 'codex' } }
  const store = moveStore(agent)
  let stateBroadcasts = 0
  let daemonRefreshes = 0
  await withServer({
    fleetStore: store,
    daemonConnections: new Map([['mini', { readyState: 1 }]]),
    broadcastState: () => { stateBroadcasts++ },
    broadcastDaemonAgentsUpdated: () => { daemonRefreshes++ },
  }, async base => {
    const res = await postJson(base, {
      agent: 'alpha',
      machine_id: 'mini',
      expected_from: 'air',
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(agent.machine_id, 'mini')
    assert.equal(store.calls.upsert.length, 1)
    assert.equal(store.calls.share[0].agentId, 'fleet:a')
    assert.equal(stateBroadcasts, 1)
    assert.equal(daemonRefreshes, 1)
  })
})
