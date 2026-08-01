import assert from 'node:assert/strict'
import test from 'node:test'

import { createDaemonWakeCore } from '../../daemon/wake-core.mjs'
import { runWakeRouteLifecycle } from './wake-route-lifecycle.mjs'

// The daemon is the only party that knows whether a process was started, so
// these build its reply with wake-core rather than writing the field by hand.
// The hand-written version said `{ already: true }`, a key the daemon has never
// sent — so the branch always read undefined, the return notice went out on
// every pause, and this suite stayed green through all of it.
function daemonWakeReply({ alive }) {
  const facts = { mintId: 'mint-1', sessionId: 'session-1' }
  const wake = createDaemonWakeCore({
    store: { resolve: () => facts, updateProcessState: () => ({}) },
    processAlive: async () => alive,
    resumeSession: async () => ({ pid: 4242 }),
  })
  return wake({ fleet_id: 'fleet:test' })
}

function harness({ wakeReply }) {
  const nudges = []
  return {
    nudges,
    args: {
      agentId: 'fleet:test',
      agent: { id: 'fleet:test' },
      daemonKey: 'mini',
      ownerDaemon: { readyState: 1 },
      nudgeText: 'New message.',
      returnNoticeText: 'You were away as hibernating for one minute.\n\nNew message.',
      sendDaemonDurable: async () => wakeReply,
      sendWakeNudge: async (...args) => nudges.push(args),
      getAgentDaemonRoute: async () => ({ daemon_key: 'mini' }),
    },
  }
}

test('does not claim an already-running agent was away', async () => {
  const { args, nudges } = harness({ wakeReply: await daemonWakeReply({ alive: true }) })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.action, 'already-awake')
  assert.equal(nudges[0][2], 'New message.')
  assert.equal(nudges[0][3], 'already-awake')
})

test('adds the return notice after an actual respawn', async () => {
  const { args, nudges } = harness({ wakeReply: await daemonWakeReply({ alive: false }) })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.action, 'respawned')
  assert.equal(nudges[0][2], 'You were away as hibernating for one minute.\n\nNew message.')
  assert.equal(nudges[0][3], 'post-respawn')
})
