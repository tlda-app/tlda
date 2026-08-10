import assert from 'node:assert/strict'
import test from 'node:test'

import { createDaemonWakeCore } from '../../daemon/wake-core.mjs'
import { runWakeRouteLifecycle } from './wake-route-lifecycle.mjs'

// Wake and notify are separate again: the daemon answers whether it started a
// process, then the channel gets the notice. These still drive wake-core so the
// server cannot invent the daemon's response shape.
function rig({ alive }) {
  const channel = []
  const wakeParams = []
  let running = alive
  const wake = createDaemonWakeCore({
    store: {
      resolve: () => ({ mintId: 'mint-1', sessionId: 'session-1', fleetId: 'fleet:test' }),
      updateProcessState: () => ({}),
    },
    processAlive: async () => running,
    resumeSession: async () => {
      running = true
      return { pid: 4242 }
    },
  })
  return {
    channel,
    wakeParams,
    args: {
      agentId: 'fleet:test',
      agent: { id: 'fleet:test' },
      daemonKey: 'mini',
      ownerDaemon: { readyState: 1 },
      nudgeText: '📬 Available message arrived: No. — call inbox() to read and respond.',
      returnNoticeText: '💻 You were away as hibernating for one minute.',
      sendDaemonDurable: async (_key, _op, params) => {
        wakeParams.push(params)
        return wake(params)
      },
      sendWakeNudge: async (_daemonKey, _agent, text, phase) => {
        channel.push({ text, phase })
        return { ok: true }
      },
      getAgentDaemonRoute: async () => ({ daemon_key: 'mini' }),
    },
  }
}

test('an agent whose process never stopped gets the channel nudge without a return notice', async () => {
  const { args, channel, wakeParams } = rig({ alive: true })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.spawnResult.alreadyAlive, true)
  assert.deepEqual(wakeParams, [{ fleet_id: 'fleet:test' }])
  assert.deepEqual(channel, [{
    text: '📬 Available message arrived: No. — call inbox() to read and respond.',
    phase: 'already-awake',
  }])
})

test('the channel return notice goes on the front only when the daemon started a process', async () => {
  const { args, channel, wakeParams } = rig({ alive: false })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.spawnResult.resumed, true)
  assert.deepEqual(wakeParams, [{ fleet_id: 'fleet:test' }])
  assert.deepEqual(channel, [{
    text: '💻 You were away as hibernating for one minute.\n\n📬 Available message arrived: No. — call inbox() to read and respond.',
    phase: 'post-respawn',
  }])
})
