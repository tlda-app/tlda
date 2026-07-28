#!/usr/bin/env node
import assert from 'node:assert/strict'

import { createDaemonMintCore } from '../daemon/mint-core.mjs'

let persistedLaunchRecipe = null
let launchedParams = null

const storedFacts = new Map()
const store = {
  ensure: id => {
    if (!storedFacts.has(id)) storedFacts.set(id, { mintId: id })
    return storedFacts.get(id)
  },
  get: id => storedFacts.get(id) || null,
  setFact: (id, fact, value) => {
    const current = storedFacts.get(id) || { mintId: id }
    if (fact === 'launch_recipe') persistedLaunchRecipe = value
    const field = fact === 'launch_recipe'
      ? 'launchRecipe'
      : fact === 'process_state'
        ? 'processState'
        : fact === 'session_id'
          ? 'sessionId'
          : fact
    storedFacts.set(id, { ...current, [field]: value })
    return storedFacts.get(id)
  },
}

const permissionSet = { operations: { read: { allow: ['cwd'], deny: [] }, write: { allow: [], deny: [] } } }

const core = createDaemonMintCore({
  store,
  launchProcess: async params => {
    launchedParams = params
    return {
      session_id: 'session-runtime-permission-set',
      permission_grant: params.permissionGrant,
      permission_set: params.permissionSet,
    }
  },
  requestSeat: async () => ({ fleet_id: 'fleet:runtime-permission-set' }),
  bindSeat: async () => {},
  mintId: () => 'mint-runtime-permission-set',
})

await core.mint({
  name: 'runtime-permission-set',
  launch: {
    cwd: '/tmp/runtime-permission-set',
    permissionGrant: 'app-dev',
    permissionSet,
  },
  request_seat: false,
})

assert.equal(launchedParams.permissionGrant, 'app-dev')
assert.equal(launchedParams.permissionSet, permissionSet)
assert.equal(persistedLaunchRecipe.permissionGrant, 'app-dev')
assert.equal(Object.hasOwn(persistedLaunchRecipe, 'permissionSet'), false)
assert.equal(Object.hasOwn(persistedLaunchRecipe, 'permission_set'), false)

const deferredStoreFacts = new Map()
const deferredCore = createDaemonMintCore({
  store: {
    ensure: id => {
      if (!deferredStoreFacts.has(id)) deferredStoreFacts.set(id, { mintId: id })
      return deferredStoreFacts.get(id)
    },
    get: id => deferredStoreFacts.get(id) || null,
    setFact: (id, fact, value) => {
      const current = deferredStoreFacts.get(id) || { mintId: id }
      const field = fact === 'launch_recipe'
        ? 'launchRecipe'
        : fact === 'process_state'
          ? 'processState'
          : fact === 'session_id'
            ? 'sessionId'
            : fact
      deferredStoreFacts.set(id, { ...current, [field]: value })
      return deferredStoreFacts.get(id)
    },
  },
  launchProcess: async () => ({
    tmux_session: 'not-derived-from-name',
    session_id: 'session-local-only',
  }),
  requestSeat: async () => { throw new Error('server unavailable') },
  bindSeat: async () => {},
  mintId: () => 'mint-local-only',
})

const deferred = await deferredCore.mint({ name: 'local-only', launch: { cwd: '/tmp' } })
assert.equal(deferred.mintId, 'mint-local-only')
assert.equal(deferred.processState.tmux_session, 'not-derived-from-name')
assert.equal(deferred.sessionId, 'session-local-only')
assert.equal(deferred.registrationError, 'server unavailable')

console.log('mint-core-runtime-permission-set-test: ok')
