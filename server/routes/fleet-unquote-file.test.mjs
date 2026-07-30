import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'
import { createFleetRouter } from './fleet.mjs'

test('unquote-file routes rechat through the durable daemon route', async () => {
  const calls = []
  const fleetStore = {
    findAgent: async () => ({ id: 'fleet:reviewer' }),
    getAgentDaemonRoute: async () => ({ agent_id: 'fleet:reviewer', daemon_key: 'mini:testing' }),
  }
  const app = express()
  app.use(express.json())
  app.use(createFleetRouter({
    fleetStore,
    broadcastEvent: () => {},
    broadcastState: () => {},
    clearEphemeralState: () => {},
    suppressEchoFor: () => {},
    sendDaemonEphemeral: async () => {
      throw new Error('unexpected ephemeral RPC')
    },
    sendDaemonDurable: async (daemonKey, op, params) => {
      calls.push({ daemonKey, op, params })
      return { resolvedMessage: 'review', inlineAttachments: [] }
    },
    resolveRpc: () => {
      throw new Error('legacy resolver must not be used')
    },
    daemonConnections: new Map(),
    resolveSpawnTarget: null,
    enqueueDaemonMessage: () => {},
    requireOperationRead: () => true,
  }))

  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const response = await fetch(`http://127.0.0.1:${port}/api/unquote-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: 17,
        quoted: '/Users/skip/work/talks/imagined-randomization-20min-review.md',
        agentId: 'fleet:reviewer',
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(calls, [{
      daemonKey: 'mini:testing',
      op: 'rechat',
      params: {
        agent_id: 'fleet:reviewer',
        text: '/Users/skip/work/talks/imagined-randomization-20min-review.md',
      },
    }])
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
