import assert from 'node:assert/strict'
import test from 'node:test'

import { createDaemonWakeCore } from '../../daemon/wake-core.mjs'
import { runWakeRouteLifecycle } from './wake-route-lifecycle.mjs'

// Wake and tell are one call, and the daemon decides whether the return notice
// goes on the front. So these drive a real wake-core with the server's own
// arguments and read what reached the terminal, rather than asserting against a
// hand-written reply — the previous version wrote `{ already: true }`, a key the
// daemon has never sent, and stayed green while every paused agent was told it
// had been away.
function rig({ alive }) {
  const injected = []
  const wake = createDaemonWakeCore({
    store: {
      resolve: () => ({ mintId: 'mint-1', sessionId: 'session-1', fleetId: 'fleet:test' }),
      updateProcessState: () => ({}),
    },
    processAlive: async () => alive,
    resumeSession: async () => ({ pid: 4242 }),
    notifyAgent: async ({ text }) => { injected.push(text); return { ok: true } },
  })
  return {
    injected,
    args: {
      agentId: 'fleet:test',
      agent: { id: 'fleet:test' },
      daemonKey: 'mini',
      ownerDaemon: { readyState: 1 },
      nudgeText: '📬 Available message arrived: No. — call inbox() to read and respond.',
      returnNoticeText: '💻 You were away as hibernating for one minute.',
      sendDaemonDurable: async (_key, _op, params) => wake(params),
      getAgentDaemonRoute: async () => ({ daemon_key: 'mini' }),
    },
  }
}

test('an agent whose process never stopped is not told it was away', async () => {
  const { args, injected } = rig({ alive: true })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.spawnResult.alreadyAlive, true)
  assert.deepEqual(injected, ['📬 Available message arrived: No. — call inbox() to read and respond.'])
})

test('the return notice goes on the front only when the daemon started a process', async () => {
  const { args, injected } = rig({ alive: false })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.spawnResult.resumed, true)
  assert.deepEqual(injected, [
    '💻 You were away as hibernating for one minute.\n\n📬 Available message arrived: No. — call inbox() to read and respond.',
  ])
})
