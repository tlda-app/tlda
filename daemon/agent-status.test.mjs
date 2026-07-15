import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentStatus } from './agent-status.mjs'

test('a vanished process pane transitions from awake to hibernating', async () => {
  const messages = []
  const agent = { id: 'fleet:test', tmux_session: 'fleet-test' }
  const status = createAgentStatus({
    sendMsg: message => messages.push(message),
    getAgents: () => [agent],
    harnessForAgent: () => ({ kind: 'codex' }),
    isConnected: () => true,
    capturePane: async () => { throw new Error('no such pane') },
  })

  status.armAgent(agent.id)
  await status.scanArmedStatus()

  assert.deepEqual(messages.at(-1), {
    type: 'agent-status',
    agentId: agent.id,
    state: 'hibernating',
    tool: null,
    ts: messages.at(-1).ts,
  })
})
