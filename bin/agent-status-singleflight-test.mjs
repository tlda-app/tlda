import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentStatus } from '../daemon/agent-status.mjs'

test('agent status start does not cold-scan the full roster', async () => {
  let captureCalls = 0
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
      return { stdout: '' }
    },
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    },
  })

  agentStatus.start()
  agentStatus.start()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(captureCalls, 0)
  assert.equal(intervals.length, 1)
})

test('agent status scans an explicitly armed agent without overlapping', async () => {
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
  agentStatus.armAgent('fleet:singleflight')
  void agentStatus.scanArmedStatus()
  void agentStatus.scanArmedStatus()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(captureCalls, 1)
  assert.equal(intervals.length, 1)

  releaseCapture()
  await new Promise(resolve => setImmediate(resolve))
})

test('agent status disarms idle agents and repeated start does not rearm all', async () => {
  const intervals = []
  const agentStatus = createAgentStatus({
    getAgents: () => [{
      id: 'fleet:idle',
      tmux_session: 'fleet-idle',
      dead: false,
      human: false,
      hibernating: false,
      metadata: {},
    }],
    harnessForAgent: () => ({ kind: 'codex' }),
    isConnected: () => true,
    sendMsg: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    capturePane: async () => ({ stdout: '' }),
    statusLingerMs: -1,
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    },
  })

  agentStatus.start()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(agentStatus.isArmed('fleet:idle'), false)

  agentStatus.start()
  assert.equal(agentStatus.isArmed('fleet:idle'), false)
  assert.equal(intervals.length, 1)
})
