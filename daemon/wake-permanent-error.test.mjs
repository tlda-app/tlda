import test from 'node:test'
import assert from 'node:assert/strict'

import { createDaemonWakeCore } from './wake-core.mjs'

// A permanent resume error (stale session: transcript in no config base)
// fails identically on every attempt, so retrying it is a storm, not
// diligence. One attempt, then the original error as the verdict.

const facts = { mintId: 'mint-1', fleetId: 'fleet:abc', sessionId: 'sess-1', launchRecipe: { kind: 'claude' } }

function staleError() {
  const error = new Error('cannot resume some-agent: session sess-1 is in no config base (searched /a, /b)')
  error.code = 'stale-session'
  error.permanent = true
  return error
}

test('a permanent resume error attempts once and re-raises unwrapped', async () => {
  let attempts = 0
  const wake = createDaemonWakeCore({
    store: {
      resolve: () => facts,
      updateProcessState: (mintId, state) => ({ ...facts, processState: state }),
    },
    processAlive: async () => false,
    retryPolicy: () => ({ attempts: 6, delayMs: 0 }),
    resumeSession: async () => { attempts += 1; throw staleError() },
  })
  const error = await wake({ fleet_id: 'fleet:abc' }).then(
    () => { throw new Error('wake should have thrown') },
    e => e,
  )
  assert.equal(attempts, 1)
  assert.equal(error.code, 'stale-session')
  assert.equal(error.permanent, true)
  assert.match(error.message, /sess-1/)
})

test('a transient resume error keeps retrying', async () => {
  let attempts = 0
  const wake = createDaemonWakeCore({
    store: {
      resolve: () => facts,
      updateProcessState: (mintId, state) => ({ ...facts, processState: state }),
    },
    processAlive: async () => false,
    retryPolicy: () => ({ attempts: 3, delayMs: 0 }),
    resumeSession: async () => { attempts += 1; throw new Error('tmux hiccup') },
  })
  const error = await wake({ fleet_id: 'fleet:abc' }).then(
    () => { throw new Error('wake should have thrown') },
    e => e,
  )
  assert.equal(attempts, 3)
  assert.match(error.message, /did not produce a live runtime/)
  assert.match(error.message, /tmux hiccup/)
})
