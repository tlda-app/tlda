import assert from 'node:assert/strict'
import test from 'node:test'

import { createPromptPlan } from '../daemon/prompt-plan.mjs'

test('prompt auto-accept sweep does not overlap fleet-wide captures', async () => {
  let captureCalls = 0
  let releaseCapture
  const firstCapture = new Promise(resolve => {
    releaseCapture = () => resolve({ stdout: '' })
  })
  const intervals = []
  const promptPlan = createPromptPlan({
    getAgents: () => [{
      id: 'fleet:prompt-singleflight',
      tmux_session: 'fleet-prompt-singleflight',
      dead: false,
      human: false,
      hibernating: false,
      metadata: {},
    }],
    isArmed: () => true,
    hasActiveTerminalWatch: () => false,
    autoAcceptPrompt: async () => {},
    sendMsg: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    execFileP: async () => {
      captureCalls += 1
      return firstCapture
    },
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    },
  })

  promptPlan.startAutoAcceptSweep()
  intervals[0].fn()
  intervals[0].fn()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(captureCalls, 1)
  assert.equal(intervals.length, 1)

  releaseCapture()
  await new Promise(resolve => setImmediate(resolve))
})
