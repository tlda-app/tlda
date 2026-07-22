import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentStatus } from '../daemon/agent-status.mjs'

test('agent status start does not launch overlapping full scans', async () => {
  let captureCalls = 0
  let releaseCapture
  const firstCapture = new Promise(resolve => {
    releaseCapture = () => resolve({ stdout: '' })
  })
  const intervals = []
  const agentStatus = createAgentStatus({
    getAgents: () => [{
      id: 'fleet:singleflight',
      tmux_session: 'fleet-singleflight',
      dead: false,
      human: false,
      hibernating: false,
      metadata: {},
    }],
    harnessForAgent: () => ({ kind: 'codex' }),
    isConnected: () => true,
    sendMsg: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    capturePane: async () => {
      captureCalls += 1
      return firstCapture
    },
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    },
  })

  agentStatus.start()
  agentStatus.start()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(captureCalls, 1)
  assert.equal(intervals.length, 1)

  releaseCapture()
  await new Promise(resolve => setImmediate(resolve))
})
