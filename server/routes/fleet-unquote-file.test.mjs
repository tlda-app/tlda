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
    sendDaemonDurable: async (daemonKey, op, params, rpcOptions) => {
      calls.push({ daemonKey, op, params, rpcOptions })
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
        quoted: '/Users/you/work/talks/imagined-randomization-20min-review.md',
        agentId: 'fleet:reviewer',
      }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(calls.map(({ rpcOptions, ...rest }) => rest), [{
      daemonKey: 'mini:testing',
      op: 'rechat',
      params: {
        agent_id: 'fleet:reviewer',
        text: '/Users/you/work/talks/imagined-randomization-20min-review.md',
      },
    }])
    // The rechat RPC must be bounded: an unbounded call parks the route
    // forever when the daemon holds its socket open and never answers.
    const rpcOptions = calls[0].rpcOptions
    assert.ok(Number.isFinite(rpcOptions?.attemptTimeoutMs) && rpcOptions.attemptTimeoutMs > 0)
    assert.ok(Number.isFinite(rpcOptions?.totalDeadlineMs) && rpcOptions.totalDeadlineMs > rpcOptions.attemptTimeoutMs)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})


