import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentStatus } from '../daemon/agent-status.mjs'
import { daemonDeliveryPolicy, DELIVERY_LATEST_WINS } from '../daemon/delivery-policy.mjs'

function fixture({ capturePane = async () => ({ stdout: '' }) } = {}) {
  const sent = []
  let listCalls = 0
  const agents = [
    { id: 'fleet:busy', tmux_session: 'fleet-busy', runtimeKind: 'codex', metadata: {} },
    { id: 'fleet:idle', tmux_session: 'fleet-idle', runtimeKind: 'codex', metadata: {} },
    { id: 'fleet:gone', tmux_session: 'fleet-gone', runtimeKind: 'codex', metadata: {} },
  ]
  const status = createAgentStatus({
    getAgents: () => agents,
    harnessForAgent: () => ({ kind: 'codex' }),
    listSessions: async () => { listCalls += 1; return { sessions: ['fleet-busy', 'fleet-idle'] } },
    isConnected: () => true,
    sendMsg: message => sent.push(message),
    log: { info() {}, warn() {}, error() {} },
    capturePane,
    daemonKey: 'mini:testing',
    daemonBootId: 7,
    statusScanMs: 3000,
    setIntervalFn: () => ({ unref() {} }),
  })
  return { status, sent, listCalls: () => listCalls }
}

test('one inventory produces one complete status result and captures only live armed panes', async () => {
  const captured = []
  const f = fixture({ capturePane: async session => { captured.push(session); return { stdout: '' } } })
  f.status.armAgent('fleet:busy')
  f.status.armAgent('fleet:gone')

  await f.status.scanStatus('test')

  assert.equal(f.listCalls(), 1)
  assert.deepEqual(captured, ['fleet-busy'])
  assert.equal(f.sent.length, 1)
  assert.deepEqual(f.sent[0].agents, [
    { agent_id: 'fleet:busy', status: 'awake', activity: 'idle', tool: null },
    { agent_id: 'fleet:idle', status: 'awake', activity: 'unknown', tool: null },
    { agent_id: 'fleet:gone', status: 'hibernating', activity: 'unknown', tool: null },
  ])
  assert.equal(f.sent[0].daemon_key, 'mini:testing')
  assert.equal(f.sent[0].daemon_boot_id, 7)
  assert.equal(f.sent[0].report_seq, 1)
})

test('overlapping ticks serialize list and capture work', async () => {
  let release
  let captures = 0
  const pane = new Promise(resolve => { release = resolve })
  const f = fixture({ capturePane: async () => { captures += 1; return pane } })
  f.status.armAgent('fleet:busy')

  const first = f.status.scanStatus('first')
  void f.status.scanStatus('second')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.listCalls(), 1)
  assert.equal(captures, 1)

  release({ stdout: '' })
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.listCalls(), 2)
})

test('a newer complete status batch replaces a queued older tick', () => {
  assert.equal(daemonDeliveryPolicy({ type: 'agent-status' }), DELIVERY_LATEST_WINS)
})
