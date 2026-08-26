import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentStatus } from '../daemon/agent-status.mjs'
import { daemonDeliveryPolicy, DELIVERY_LATEST_WINS } from '../daemon/delivery-policy.mjs'

function fixture({ capturePane = async () => ({ stdout: '' }), processes = null, resolveProcessIdentity = null } = {}) {
  const sent = []
  let listCalls = 0
  const agents = [
    { id: 'fleet:gone', daemonKey: 'mini:testing', tmux_session: 'fleet-gone', runtimeKind: 'codex', metadata: {} },
  ]
  const identities = new Map([
    [101, { id: 'fleet:busy', daemonKey: 'mini:testing', friendly_name: 'busy', tmux_session: 'fleet-busy', runtimeKind: 'codex', metadata: {} }],
    [102, { id: 'fleet:idle', daemonKey: 'mini:testing', friendly_name: 'idle', tmux_session: 'fleet-idle', runtimeKind: 'codex', metadata: {} }],
    [103, { id: 'fleet:stable', daemonKey: 'mini:stable', friendly_name: 'stable', tmux_session: 'fleet-stable', runtimeKind: 'codex', metadata: {} }],
  ])
  const status = createAgentStatus({
    getAgents: () => agents,
    harnessForAgent: () => ({ kind: 'codex' }),
    listSessions: async () => {
      listCalls += 1
      return { processes: processes || [
        { session: 'fleet-busy', pid: 101 },
        { session: 'fleet-idle', pid: 102 },
        { session: 'fleet-stable', pid: 103 },
      ] }
    },
    resolveProcessIdentity: resolveProcessIdentity || (async process => identities.get(process.pid) || null),
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

test('one process inventory emits a live unledgered agent, excludes stale ledger rows, and captures only armed panes', async () => {
  const captured = []
  const f = fixture({ capturePane: async session => { captured.push(session); return { stdout: '' } } })
  f.status.armAgent('fleet:busy')
  f.status.armAgent('fleet:gone')

  await f.status.scanStatus('test')

  assert.equal(f.listCalls(), 1)
  assert.deepEqual(captured, ['fleet-busy'])
  assert.equal(f.sent.length, 1)
  assert.deepEqual(f.sent[0].agents, [
    { agent_id: 'fleet:busy', status: 'awake', activity: 'idle', tool: null, identity: { friendly_name: 'busy', runtime_kind: 'codex' } },
    { agent_id: 'fleet:idle', status: 'awake', activity: 'unknown', tool: null, identity: { friendly_name: 'idle', runtime_kind: 'codex' } },
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

test('the complete batch carries the latest real tool observation', async () => {
  const f = fixture()
  f.status.noteToolActivity('fleet:busy', 'exec_command')

  await f.status.scanStatus('tool')

  assert.deepEqual(f.sent[0].agents[0], {
    agent_id: 'fleet:busy',
    status: 'awake',
    activity: 'tool_call:exec_command',
    tool: 'exec_command',
    identity: { friendly_name: 'busy', runtime_kind: 'codex' },
  })
})

test('an unresolved listed pane suppresses the complete generation', async () => {
  const f = fixture({
    processes: [{ session: 'fleet-unknown', pid: 999 }],
    resolveProcessIdentity: async () => null,
  })

  await f.status.scanStatus('unresolved')

  assert.deepEqual(f.sent, [])
})

// This test used to assert `sent` was empty: a duplicate identity suppressed the
// whole generation. That is the all-or-nothing behaviour removed here. The pane
// is ambiguous, but the STATUS is not -- whichever pane it is, the id is live --
// so the ambiguous extra pane is dropped and the agent is still reported awake.
test('duplicate live fleet identities report the agent once instead of suppressing the generation', async () => {
  const f = fixture({
    processes: [
      { session: 'fleet-duplicate-a', pid: 201 },
      { session: 'fleet-duplicate-b', pid: 202 },
    ],
    resolveProcessIdentity: async process => ({
      id: 'fleet:duplicate',
      daemonKey: 'mini:testing',
      friendly_name: 'duplicate',
      tmux_session: process.session,
      runtimeKind: 'codex',
      metadata: { kind: 'codex' },
    }),
  })

  await f.status.scanStatus('duplicate')

  assert.equal(f.sent.length, 1)
  assert.deepEqual(f.sent[0].agents.map(a => a.agent_id), ['fleet:duplicate'])
  assert.equal(f.sent[0].snapshot_complete, true)
})

// THE COUNTERFACTUAL for the always-hibernating defect. Before this change the
// unidentifiable pane threw, `scanStatus` returned, and NOTHING was sent -- so no
// agent received a runtime_status and the whole fleet rendered as hibernating.
// `tmux list-sessions` returns every session on the machine, so an ordinary shell
// reaches this code path as readily as a broken harness.
test('one unidentifiable pane does not suppress status for the panes that are identifiable', async () => {
  const f = fixture({
    processes: [
      { session: 'fleet-busy', pid: 101 },
      { session: 'fleet-idle', pid: 102 },
      { session: 'fleet-stable', pid: 103 },
      { session: 'skips-own-shell', pid: 999 },
    ],
  })
  f.status.armAgent('fleet:busy')

  await f.status.scanStatus('unidentifiable-pane')

  assert.equal(f.sent.length, 1, 'a batch is still published')
  const batch = f.sent[0]
  // fleet:stable belongs to mini:stable, so it is correctly excluded by daemon key
  // rather than by the malformed pane.
  assert.deepEqual(batch.agents.map(a => a.agent_id).sort(), ['fleet:busy', 'fleet:idle'])
  assert.ok(batch.agents.every(a => a.status === 'awake'))
  assert.equal(batch.snapshot_complete, true)
})

test('a newer complete status batch replaces a queued older tick', () => {
  assert.equal(daemonDeliveryPolicy({ type: 'agent-status' }), DELIVERY_LATEST_WINS)
})
