#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'

let receivedFacts = null
let receivedParams = null

const wake = createDaemonWakeCore({
  store: {
    getByFleetId: fleetId => ({
      mintId: 'mint-1',
      fleetId,
      sessionId: 'session-1',
      launchRecipe: { permissionGrant: 'old-grant' },
    }),
  },
  processAlive: async () => false,
  resumeSession: async (facts, params) => {
    receivedFacts = facts
    receivedParams = params
    return { resumed: true }
  },
})

const result = await wake({
  fleet_id: 'fleet:test',
  permissionGrant: 'wd',
  permissionSet: { operations: { read: { allow: ['.'], deny: [] }, write: { allow: ['.'], deny: [] } } },
})

assert.equal(result.ok, true)
assert.equal(result.resumed, true)
assert.equal(receivedFacts.fleetId, 'fleet:test')
assert.equal(receivedParams.permissionGrant, 'wd')
assert.deepEqual(receivedParams.permissionSet.operations.read.allow, ['.'])

console.log('wake core params regression: ok')
