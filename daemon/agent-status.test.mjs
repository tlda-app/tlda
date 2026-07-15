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

test('the status watcher keeps observing idle processes until they hibernate', async () => {
  const agent = { id: 'fleet:test', tmux_session: 'fleet-test' }
  let tick
  let captures = 0
  const status = createAgentStatus({
    sendMsg() {},
    getAgents: () => [agent],
    harnessForAgent: () => ({ kind: 'codex' }),
    isConnected: () => true,
    armLingerMs: 0,
    capturePane: async () => {
      captures += 1
      return { stdout: 'idle prompt' }
    },
    setIntervalFn: callback => {
      tick = callback
      return { unref() {} }
    },
  })

  status.start()
  await tick()
  await tick()

  assert.equal(captures, 2)
  assert.equal(status.isArmed(agent.id), true)
})

test('status observation uses daemon process bindings without a server roster', async () => {
  const binding = { id: 'fleet:ledger', tmux_session: 'fleet-ledger', metadata: { kind: 'codex' } }
  let tick
  const emitted = []
  const status = createAgentStatus({
    sendMsg: message => emitted.push(message),
    getAgents: () => [binding],
    harnessForAgent: agent => ({ kind: agent.metadata.kind }),
    isConnected: () => true,
    capturePane: async () => { throw new Error('process absent') },
    setIntervalFn: callback => {
      tick = callback
      return { unref() {} }
    },
  })

  status.start()
  await tick()

  assert.equal(emitted.at(-1).agentId, binding.id)
  assert.equal(emitted.at(-1).state, 'hibernating')
})
