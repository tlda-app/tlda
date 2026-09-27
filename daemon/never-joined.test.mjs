// P1 daemon verdicts: process-grounded, never clock-grounded. A listed
// session with a live process emits leaked-alive (informational — a live
// process is never a failure); a session observed absent from the list, or
// listed but confirmed dead, emits absent (a positive observation). An
// unobserved list, an inconclusive probe, or a row with no recorded session
// emits nothing: not looking is not evidence, and an absent record is not an
// absent process.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { examineNeverJoinedRow, neverJoinedCutoffIso } from './never-joined.mjs'

function facts(overrides = {}) {
  return {
    mintId: 'mint-1',
    fleetId: 'fleet:test',
    friendlyName: 'test',
    joinedAt: null,
    createdAt: '2026-09-26T00:00:00.000Z',
    processState: { tmux_session: 'fleet-test', daemon_key: 'mini:testing' },
    ...overrides,
  }
}

async function examine({ row, list = null, probe = null, emitted = new Set(), calls = null }) {
  const sent = []
  const verdict = await examineNeverJoinedRow({
    facts: row,
    listSessions: async () => { calls?.push('list'); return list },
    probeSession: async session => { calls?.push(`probe:${session}`); return probe(session) },
    emit: async msg => { sent.push(msg) },
    emitted,
    daemonKey: 'mini:testing',
  })
  return { verdict, sent, emitted }
}

const liveProbe = async () => ({ probed: true, alive: true, pids: [4242] })
const deadProbe = async () => ({ probed: true, alive: false, pids: [4242] })
const blindProbe = async () => ({ probed: false, alive: false, pids: [] })

test('listed session with live process emits leaked-alive with the approved shape', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-test', 'fleet-other'] },
    probe: liveProbe,
  })
  assert.equal(verdict, 'leaked-alive')
  assert.equal(sent.length, 1)
  const [msg] = sent
  assert.equal(msg.type, 'never-joined')
  assert.equal(msg.verdict, 'leaked-alive')
  assert.equal(msg.agent_id, 'fleet:test')
  assert.equal(msg.mint_id, 'mint-1')
  assert.equal(msg.daemon_key, 'mini:testing')
  assert.equal(msg.observed.session, 'fleet-test')
  assert.equal(msg.observed.session_listed, true)
  assert.equal(msg.observed.runtime, true)
  assert.deepEqual(msg.observed.pane_pids, [4242])
  assert.ok(msg.observed.checked_at)
  assert.ok(msg.ts)
})

test('listed session with live pane pid but no agent runtime emits leaked-alive (design: pane pid dead is the test)', async () => {
  // The pane holds a live non-agent process (a bare sleep, a stray shell):
  // pane pid signals OK, but no agent CLI would be detected in its subtree.
  // The design's own test is pane-pid existence, not runtime detection, so
  // this is leaked-alive — and runtime-semantics answering absent here is
  // the deviation, caught by the harness on a sleep specimen 2026-09-27.
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-test'] },
    probe: async () => ({ probed: true, alive: true, pids: [4242] }),
  })
  assert.equal(verdict, 'leaked-alive')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].observed.session_listed, true)
  assert.equal(sent[0].observed.runtime, true)
  assert.deepEqual(sent[0].observed.pane_pids, [4242])
})

test('session observed absent from the list emits absent without probing', async () => {
  const calls = []
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-other'] },
    probe: liveProbe,
    calls,
  })
  assert.equal(verdict, 'absent')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].verdict, 'absent')
  assert.equal(sent[0].observed.session_listed, false)
  assert.deepEqual(calls, ['list'], 'absence comes from the list; no per-session probe runs')
})

test('listed but confirmed-dead session emits absent', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-test'] },
    probe: deadProbe,
  })
  assert.equal(verdict, 'absent')
  assert.equal(sent[0].observed.session_listed, true)
  assert.deepEqual(sent[0].observed.pane_pids, [4242])
})

test('listed session with no panes emits absent', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-test'] },
    probe: async () => ({ probed: true, alive: false, pids: [] }),
  })
  assert.equal(verdict, 'absent')
  assert.equal(sent[0].observed.session_listed, true)
  assert.deepEqual(sent[0].observed.pane_pids, [])
})

test('unobserved list emits nothing even for a missing name', async () => {
  const calls = []
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: false, names: [], error: 'tmux unreachable' },
    probe: liveProbe,
    calls,
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
  assert.deepEqual(calls, ['list'])
})

test('inconclusive probe on a listed session emits nothing', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-test'] },
    probe: blindProbe,
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('probe and list failures emit nothing', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-test'] },
    probe: async () => { throw new Error('ps timed out') },
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
  const nullList = await examine({ row: facts(), list: null, probe: liveProbe })
  assert.equal(nullList.verdict, null)
  assert.deepEqual(nullList.sent, [])
})

test('no recorded session emits nothing, never absent, without listing', async () => {
  const calls = []
  const { verdict, sent } = await examine({
    row: facts({ processState: null }),
    list: { probed: true, names: [] },
    probe: liveProbe,
    calls,
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
  assert.deepEqual(calls, [], 'nothing recorded means nothing to look for')
})

test('joined row emits nothing', async () => {
  const { verdict, sent } = await examine({
    row: facts({ joinedAt: '2026-09-26T00:01:00.000Z' }),
    list: { probed: true, names: ['fleet-test'] },
    probe: liveProbe,
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('duplicate (mint, verdict) is not re-emitted', async () => {
  const emitted = new Set(['mint-1:leaked-alive'])
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-test'] },
    probe: liveProbe,
    emitted,
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('a changed verdict emits (process died after leaked-alive)', async () => {
  const emitted = new Set(['mint-1:leaked-alive'])
  const { verdict, sent } = await examine({
    row: facts(),
    list: { probed: true, names: ['fleet-other'] },
    probe: liveProbe,
    emitted,
  })
  assert.equal(verdict, 'absent')
  assert.equal(sent.length, 1)
})

test('missing fleet id passes through null with mint linkage intact', async () => {
  const { verdict, sent } = await examine({
    row: facts({ fleetId: null }),
    list: { probed: true, names: ['fleet-test'] },
    probe: liveProbe,
  })
  assert.equal(verdict, 'leaked-alive')
  assert.equal(sent[0].agent_id, null)
  assert.equal(sent[0].mint_id, 'mint-1')
})

test('grace cutoff is ten minutes before now', () => {
  const now = new Date('2026-09-27T12:00:00.000Z').getTime()
  assert.equal(neverJoinedCutoffIso(now), '2026-09-27T11:50:00.000Z')
})
