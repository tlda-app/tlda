import assert from 'node:assert/strict'
import test from 'node:test'

import { isObservableDaemonProcessBinding } from '../agent-runtime/daemon-process-binding.mjs'
import { shouldPromptSweepAgent } from '../agent-runtime/status-classifier.mjs'
import { createAgentStatus } from './agent-status.mjs'

test('a stored hibernating flag does not veto observation', () => {
  assert.equal(
    isObservableDaemonProcessBinding({ id: 'fleet:a', tmux_session: 'fleet-a', hibernating: true }),
    true,
  )
  assert.equal(
    isObservableDaemonProcessBinding({ id: 'fleet:a', tmux_session: 'fleet-a' }),
    true,
  )
})

test('observability still requires a live non-human binding with a terminal', () => {
  assert.equal(isObservableDaemonProcessBinding(null), false)
  assert.equal(isObservableDaemonProcessBinding({ id: 'fleet:a', tmux_session: 'fleet-a', dead: true }), false)
  assert.equal(isObservableDaemonProcessBinding({ id: 'fleet:a', tmux_session: 'fleet-a', human: true }), false)
  assert.equal(isObservableDaemonProcessBinding({ id: 'fleet:a', hibernating: true }), false)
})

test('the prompt sweep stays eligible for a flagged-hibernating armed agent', () => {
  assert.equal(
    shouldPromptSweepAgent(
      { id: 'fleet:a', tmux_session: 'fleet-a', hibernating: true },
      { armed: true },
    ),
    true,
  )
})

test('the status scan reads a flagged-hibernating live pane instead of disarming', async () => {
  const sent = []
  const agents = [{ id: 'fleet:a', tmux_session: 'fleet-a', hibernating: true }]
  const status = createAgentStatus({
    tmuxArgs: [],
    sendMsg: msg => sent.push(msg),
    log: { info() {} },
    getAgents: () => agents,
    harnessForAgent: () => ({ kind: 'claude' }),
    isConnected: () => true,
    statusScanMs: 1000,
    setIntervalFn: () => ({ unref() {} }),
    capturePane: async () => ({ stdout: 'Working…\nesc to interrupt' }),
  })

  status.armAgent('fleet:a')
  await status.scanStatus()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'agent-status')
  assert.equal(sent[0].agent_id, 'fleet:a')
  assert.equal(sent[0].activity, 'thinking')
  assert.equal(status.isArmed('fleet:a'), true)
})
