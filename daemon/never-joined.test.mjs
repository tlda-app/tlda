// P1 daemon verdicts: process-grounded, never clock-grounded. Alive emits
// leaked-alive (informational — a live process is never a failure);
// confirmed-gone emits absent (a positive observation). An inconclusive probe
// or a row with no recorded session emits nothing: not looking is not
// evidence, and an absent record is not an absent process.

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

async function examine({ row, probe, emitted = new Set() }) {
  const sent = []
  const verdict = await examineNeverJoinedRow({
    facts: row,
    probeSession: probe,
    emit: async msg => { sent.push(msg) },
    emitted,
    daemonKey: 'mini:testing',
  })
  return { verdict, sent, emitted }
}

test('live process emits leaked-alive with the approved shape', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    probe: async () => ({ runtime: true, mcp: false, probed: true }),
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
  assert.equal(msg.observed.runtime, true)
  assert.ok(msg.observed.checked_at)
  assert.ok(msg.ts)
})

test('confirmed-gone process emits absent', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    probe: async () => ({ runtime: false, mcp: false, probed: true }),
  })
  assert.equal(verdict, 'absent')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].verdict, 'absent')
  assert.equal(sent[0].observed.runtime, false)
})

test('inconclusive probe emits nothing', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    probe: async () => ({ runtime: false, mcp: false, probed: false }),
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('probe failure emits nothing', async () => {
  const { verdict, sent } = await examine({
    row: facts(),
    probe: async () => { throw new Error('ps timed out') },
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('no recorded session emits nothing, never absent', async () => {
  let probed = 0
  const { verdict, sent } = await examine({
    row: facts({ processState: null }),
    probe: async () => { probed += 1; return { runtime: false, probed: true } },
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
  assert.equal(probed, 0, 'nothing recorded means nothing to probe')
})

test('joined row emits nothing', async () => {
  const { verdict, sent } = await examine({
    row: facts({ joinedAt: '2026-09-26T00:01:00.000Z' }),
    probe: async () => ({ runtime: true, probed: true }),
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('duplicate (mint, verdict) is not re-emitted', async () => {
  const emitted = new Set(['mint-1:leaked-alive'])
  const { verdict, sent } = await examine({
    row: facts(),
    probe: async () => ({ runtime: true, probed: true }),
    emitted,
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('a changed verdict emits (process died after leaked-alive)', async () => {
  const emitted = new Set(['mint-1:leaked-alive'])
  const { verdict, sent } = await examine({
    row: facts(),
    probe: async () => ({ runtime: false, probed: true }),
    emitted,
  })
  assert.equal(verdict, 'absent')
  assert.equal(sent.length, 1)
})

test('missing fleet id passes through null with mint linkage intact', async () => {
  const { verdict, sent } = await examine({
    row: facts({ fleetId: null }),
    probe: async () => ({ runtime: true, probed: true }),
  })
  assert.equal(verdict, 'leaked-alive')
  assert.equal(sent[0].agent_id, null)
  assert.equal(sent[0].mint_id, 'mint-1')
})

test('grace cutoff is ten minutes before now', () => {
  const now = new Date('2026-09-27T12:00:00.000Z').getTime()
  assert.equal(neverJoinedCutoffIso(now), '2026-09-27T11:50:00.000Z')
})
