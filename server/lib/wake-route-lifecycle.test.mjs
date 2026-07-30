import assert from 'node:assert/strict'
import test from 'node:test'

import { runWakeRouteLifecycle } from './wake-route-lifecycle.mjs'

function harness({ already }) {
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
      sendDaemonDurable: async () => ({ ok: true, already }),
      sendWakeNudge: async (...args) => nudges.push(args),
      getAgentDaemonRoute: async () => ({ daemon_key: 'mini' }),
    },
  }
}

test('does not claim an already-running agent was away', async () => {
  const { args, nudges } = harness({ already: true })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.action, 'already-awake')
  assert.equal(nudges[0][2], 'New message.')
  assert.equal(nudges[0][3], 'already-awake')
})

test('adds the return notice after an actual respawn', async () => {
  const { args, nudges } = harness({ already: false })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.action, 'respawned')
  assert.equal(nudges[0][2], 'You were away as hibernating for one minute.\n\nNew message.')
  assert.equal(nudges[0][3], 'post-respawn')
})
