import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { createFleetRouter } from '../server/routes/fleet.mjs'

function startApp({ caller, daemonConnections, sendRpc }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.fleetCallerId = caller.id
    next()
  })
  app.use(createFleetRouter({
    fleetStore: {
      getAgent: (id) => id === caller.id ? caller : null,
      findAgent: () => null,
    },
    broadcastEvent: () => {},
    broadcastState: () => {},
    clearEphemeralState: () => {},
    suppressEchoFor: () => {},
    sendRpc,
    resolveRpc: () => ({ via: 'none', code: 503, error: 'not used' }),
    daemonConnections,
    resolveSpawnTarget: null,
  }))
  const server = http.createServer(app)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('HTTP spawn falls back to the single connected daemon when caller machine_id is stale', async (t) => {
  const caller = {
    id: 'fleet:caller',
    friendly_name: 'caller',
    machine_id: 'air-old',
    metadata: { spawnPolicy: { capability: 'full', policy: 'unsandboxed' } },
  }
  const daemonConnections = new Map([
    ['air', { readyState: 1 }],
  ])
  const calls = []
  const server = await startApp({
    caller,
    daemonConnections,
    sendRpc: async (machineId, op, params) => {
      calls.push({ machineId, op, params })
      return { ok: true, agent: { id: 'fleet:new-agent' } }
    },
  })
  t.after(() => server.close())

  const { port } = server.address()
  const res = await fetch(`http://127.0.0.1:${port}/api/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'new-agent', fresh: true, kind: 'codex', capability: 'full' }),
  })
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].machineId, 'air')
  assert.equal(calls[0].op, 'spawn')
})
