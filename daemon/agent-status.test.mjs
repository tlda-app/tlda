import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentStatus } from './agent-status.mjs'

function scanner({ panes }) {
  const sent = []
  const agents = [{ id: 'fleet:a', tmux_session: 'fleet-a', sessionKind: 'claude' }]
  const status = createAgentStatus({
    tmuxArgs: [],
    sendMsg: msg => sent.push(msg),
    log: { info() {} },
    getAgents: () => agents,
    harnessForAgent: () => ({ kind: 'claude' }),
    isConnected: () => true,
    statusScanMs: 1000,
    setIntervalFn: () => ({ unref() {} }),
    capturePane: async () => ({ stdout: panes.shift() || '' }),
  })
  return { status, sent }
}

test('sustained text generation is working when the pane still shows a spinner', async () => {
  const { status, sent } = scanner({
    panes: ['draft text streaming\nWorking…\nesc to interrupt'],
  })

  status.armAgent('fleet:a')
  await status.scanStatus()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'agent-status')
  assert.equal(sent[0].agent_id, 'fleet:a')
  assert.equal(sent[0].activity, 'thinking')
})

test('finished prompt becomes idle only after the quiet pane is confirmed', async () => {
  const { status, sent } = scanner({
    panes: [
      'Working…\nEsc to interrupt',
      'done\n❯ ',
      'done\n❯ ',
    ],
  })

  status.armAgent('fleet:a')
  await status.scanStatus()
  await status.scanStatus()
  await status.scanStatus()

  assert.deepEqual(sent.map(msg => msg.activity), ['thinking', 'idle'])
})
