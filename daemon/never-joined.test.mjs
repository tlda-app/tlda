// P1 daemon verdicts read the liveness machine, never a probe of their own.
// Machine hibernating -> absent (a positive reading of no process). Machine
// awake or dying with no attestable session -> leaked-alive (informational).
// Waking or null with no attestable session -> nothing. An attested record
// joins through late resolution and no verdict emits: the discovery deadline
// stops the mint waiting, and the sweep running forever is what stops it from
// converting "not yet" into "never".

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

async function examine({ row, state = null, live = null, emitted = new Set(), calls = null }) {
  const sent = []
  const adopted = []
  const verdict = await examineNeverJoinedRow({
    facts: row,
    livenessState: async agentId => { calls?.push(`state:${agentId}`); return state },
    resolveIdentity: async () => { calls?.push('resolve'); return live },
    adoptIdentity: async session => { calls?.push('adopt'); adopted.push(session) },
    emit: async msg => { sent.push(msg) },
    emitted,
    daemonKey: 'mini:testing',
  })
  return { verdict, sent, emitted, adopted }
}

test('machine hibernating emits absent without resolving', async () => {
  const calls = []
  const { verdict, sent } = await examine({ row: facts(), state: 'hibernating', calls })
  assert.equal(verdict, 'absent')
  assert.equal(sent.length, 1)
  const [msg] = sent
  assert.equal(msg.type, 'never-joined')
  assert.equal(msg.verdict, 'absent')
  assert.equal(msg.agent_id, 'fleet:test')
  assert.equal(msg.mint_id, 'mint-1')
  assert.equal(msg.daemon_key, 'mini:testing')
  assert.equal(msg.observed.session, 'fleet-test')
  assert.equal(msg.observed.machine_state, 'hibernating')
  assert.equal(msg.observed.runtime, false)
  assert.ok(msg.observed.checked_at)
  assert.ok(msg.ts)
  assert.deepEqual(calls, ['state:fleet:test'], 'absence comes from the machine; no resolution runs')
})

test('machine awake with no attestable session emits leaked-alive', async () => {
  const calls = []
  const { verdict, sent } = await examine({ row: facts(), state: 'awake', live: null, calls })
  assert.equal(verdict, 'leaked-alive')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].observed.machine_state, 'awake')
  assert.equal(sent[0].observed.runtime, true)
  assert.deepEqual(calls, ['state:fleet:test', 'resolve'])
})

test('machine dying with no attestable session emits leaked-alive', async () => {
  const { verdict, sent } = await examine({ row: facts(), state: 'dying', live: null })
  assert.equal(verdict, 'leaked-alive')
  assert.equal(sent[0].observed.machine_state, 'dying')
})

test('an attested record joins instead of emitting, on any alive reading', async () => {
  for (const state of ['awake', 'dying', 'waking', null]) {
    const { verdict, sent, adopted } = await examine({
      row: facts(), state, live: { sessionId: 'sess-1', jsonlPath: '/s/sess-1.jsonl' },
    })
    assert.equal(verdict, 'joined', `state ${state}`)
    assert.deepEqual(sent, [], `state ${state}`)
    assert.deepEqual(adopted, [{ session_id: 'sess-1', session_path: '/s/sess-1.jsonl' }], `state ${state}`)
  }
})

test('machine waking with no attestable session emits nothing', async () => {
  const { verdict, sent } = await examine({ row: facts(), state: 'waking', live: null })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('no machine reading and no attestable session emits nothing', async () => {
  const { verdict, sent } = await examine({ row: facts(), state: null, live: null })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('a throwing machine read is not evidence', async () => {
  const sent = []
  const verdict = await examineNeverJoinedRow({
    facts: facts(),
    livenessState: async () => { throw new Error('ledger unreadable') },
    resolveIdentity: async () => null,
    adoptIdentity: async () => {},
    emit: async msg => { sent.push(msg) },
    emitted: new Set(),
    daemonKey: 'mini:testing',
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('a throwing resolution is not evidence', async () => {
  const sent = []
  const verdict = await examineNeverJoinedRow({
    facts: facts(),
    livenessState: async () => 'awake',
    resolveIdentity: async () => { throw new Error('ps timed out') },
    adoptIdentity: async () => {},
    emit: async msg => { sent.push(msg) },
    emitted: new Set(),
    daemonKey: 'mini:testing',
  })
  assert.equal(verdict, 'leaked-alive')
  assert.equal(sent.length, 1)
})

test('an adopt failure propagates for the sweep wrapper to report', async () => {
  await assert.rejects(() => examineNeverJoinedRow({
    facts: facts(),
    livenessState: async () => 'awake',
    resolveIdentity: async () => ({ sessionId: 'sess-1', jsonlPath: null }),
    adoptIdentity: async () => { throw new Error('bind failed') },
    emit: async () => {},
    emitted: new Set(),
    daemonKey: 'mini:testing',
  }), /bind failed/)
})

test('seatless row with an attested record emits leaked-alive on mint linkage', async () => {
  const { verdict, sent, adopted } = await examine({
    row: facts({ fleetId: null }),
    live: { sessionId: 'sess-1', jsonlPath: '/s/sess-1.jsonl' },
  })
  assert.equal(verdict, 'leaked-alive')
  assert.equal(sent[0].agent_id, null)
  assert.equal(sent[0].mint_id, 'mint-1')
  assert.deepEqual(adopted, [{ session_id: 'sess-1', session_path: '/s/sess-1.jsonl' }])
})

test('seatless row with nothing attested emits nothing', async () => {
  const { verdict, sent } = await examine({ row: facts({ fleetId: null }), live: null })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('no recorded session emits nothing, never absent, without reading anything', async () => {
  const calls = []
  const { verdict, sent } = await examine({ row: facts({ processState: null }), state: 'hibernating', calls })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
  assert.deepEqual(calls, [], 'nothing recorded means nothing to look for')
})

test('joined row emits nothing', async () => {
  const calls = []
  const { verdict, sent } = await examine({
    row: facts({ joinedAt: '2026-09-26T00:01:00.000Z' }), state: 'hibernating', calls,
  })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
  assert.deepEqual(calls, [])
})

test('duplicate (mint, verdict) is not re-emitted', async () => {
  const emitted = new Set(['mint-1:leaked-alive'])
  const { verdict, sent } = await examine({ row: facts(), state: 'awake', live: null, emitted })
  assert.equal(verdict, null)
  assert.deepEqual(sent, [])
})

test('a changed verdict emits (process died after leaked-alive)', async () => {
  const emitted = new Set(['mint-1:leaked-alive'])
  const { verdict, sent } = await examine({ row: facts(), state: 'hibernating', emitted })
  assert.equal(verdict, 'absent')
  assert.equal(sent.length, 1)
})

test('grace cutoff is ten minutes before now', () => {
  const now = new Date('2026-09-27T12:00:00.000Z').getTime()
  assert.equal(neverJoinedCutoffIso(now), '2026-09-27T11:50:00.000Z')
})
