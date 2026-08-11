import assert from 'node:assert/strict'
import test from 'node:test'

import { createDaemonWakeCore } from '../../daemon/wake-core.mjs'
import { runWakeRouteLifecycle } from './wake-route-lifecycle.mjs'

// Wake and tell are one call: the daemon is the only side that knows whether it
// started a process, so it decides whether the return notice goes on the front.
function rig({ alive }) {
  const injected = []
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
    notifyAgent: async ({ text, enterDelayMs }) => {
      injected.push({ text, enterDelayMs })
      return { ok: true }
    },
  })
  return {
    injected,
    wakeParams,
    args: {
      agentId: 'fleet:test',
      agent: { id: 'fleet:test' },
      daemonKey: 'mini',
      ownerDaemon: { readyState: 1 },
      nudgeText: '📬 Available message arrived: No. — call inbox() to read and respond.',
      returnNoticeText: '💻 You were away as hibernating for one minute.',
      enterDelayMs: 400,
      sendDaemonDurable: async (_key, _op, params) => {
        wakeParams.push(params)
        return wake(params)
      },
      getAgentDaemonRoute: async () => ({ daemon_key: 'mini' }),
    },
  }
}

test('an agent whose process never stopped gets the nudge without a return notice', async () => {
  const { args, injected, wakeParams } = rig({ alive: true })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.spawnResult.alreadyAlive, true)
  assert.deepEqual(wakeParams, [{
    fleet_id: 'fleet:test',
    notify_text: '📬 Available message arrived: No. — call inbox() to read and respond.',
    return_notice: '💻 You were away as hibernating for one minute.',
    enter_delay_ms: 400,
  }])
  assert.deepEqual(injected, [{
    text: '📬 Available message arrived: No. — call inbox() to read and respond.',
    enterDelayMs: 400,
  }])
})

test('the return notice goes on the front only when the daemon started a process', async () => {
  const { args, injected, wakeParams } = rig({ alive: false })

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.spawnResult.resumed, true)
  assert.deepEqual(wakeParams, [{
    fleet_id: 'fleet:test',
    notify_text: '📬 Available message arrived: No. — call inbox() to read and respond.',
    return_notice: '💻 You were away as hibernating for one minute.',
    enter_delay_ms: 400,
  }])
  assert.deepEqual(injected, [{
    text: '💻 You were away as hibernating for one minute.\n\n📬 Available message arrived: No. — call inbox() to read and respond.',
    enterDelayMs: 400,
  }])
})

test('a return notice without a nudge is still delivered on restart', async () => {
  const { args, injected, wakeParams } = rig({ alive: false })
  args.nudgeText = null
  args.returnNoticeText = 'Your MCP was restarted. Call login(), then inbox().'

  const result = await runWakeRouteLifecycle(args)

  assert.equal(result.spawnResult.resumed, true)
  assert.deepEqual(wakeParams, [{
    fleet_id: 'fleet:test',
    notify_text: 'Your MCP was restarted. Call login(), then inbox().',
    enter_delay_ms: 400,
  }])
  assert.deepEqual(injected, [{
    text: 'Your MCP was restarted. Call login(), then inbox().',
    enterDelayMs: 400,
  }])
})
