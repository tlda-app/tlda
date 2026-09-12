import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import express from 'express'

import { createFleetRouter } from './fleet.mjs'

test('singleton-seat route invokes the one authoritative transaction', async () => {
  const calls = []
  let broadcasts = 0
  const fleetStore = {
    findAgent: async query => ({ id: query, friendly_name: 'incoming' }),
    assignSingletonSeat: async args => {
      calls.push(args)
      return {
        label: args.label,
        agent: args.agentId,
        subscriptions: {
          direct: { notification_policy: 'immediate' },
          labels: { notification_policy: 'batch(default)' },
        },
      }
    },
  }
  const app = express()
  app.use(express.json())
  app.use(createFleetRouter({
    fleetStore,
    broadcastEvent: () => {}, broadcastState: () => { broadcasts++ }, clearEphemeralState: () => {}, suppressEchoFor: () => {},
    sendDaemonEphemeral: async () => {}, sendDaemonDurable: async () => {}, resolveRpc: () => {},
    daemonConnections: new Map(), resolveSpawnTarget: null, enqueueDaemonMessage: () => {}, requireOperationRead: () => true,
  }))
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const response = await fetch(`http://127.0.0.1:${port}/api/singleton-seat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'chief', agent: 'fleet:incoming', transfer: false, actor: 'fleet:skip' }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
    assert.deepEqual(calls, [{
      label: 'chief', agentId: 'fleet:incoming', actorId: 'fleet:skip', transfer: false, batchPolicy: 'batch(default)',
    }])
    assert.equal(broadcasts, 1)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
