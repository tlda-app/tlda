// P1 admission: ownership-verified, idempotent on (mint_id, verdict).
// absent retires a live shell; leaked-alive records + notifies without
// touching shell or task; duplicates and foreign verdicts change nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { admitNeverJoinedVerdict, notifyOwningDaemonOfFailure } from './never-joined-admission.mjs'
import { FleetStore } from './fleet-store.mjs'

function liveAgent(overrides = {}) {
  return {
    id: 'fleet:test',
    friendly_name: 'test',
    dead: 0,
    metadata: { shell: true, spawn_daemon_key: 'mini:testing', daemon_mint_id: 'mint-1' },
    ...overrides,
  }
}

function harness({ agent = liveAgent(), tasks = [{ id: 'task-1', delegated_by: 'fleet:owner' }], mailboxEntry = {}, route = null } = {}) {
  const calls = { retired: [], chats: [], completions: [], meta: [] }
  const agentRow = agent ? JSON.parse(JSON.stringify(agent)) : null
  const store = {
    getAgent: async id => (agentRow && id === agentRow.id ? agentRow : null),
    findAgentByDaemonMintId: async mintId => (agentRow && agentRow.metadata?.daemon_mint_id === mintId ? agentRow.id : null),
    getAgentDaemonRoute: async () => route,
    retirePendingShell: async id => { calls.retired.push(id); if (agentRow) agentRow.dead = 1; return true },
    getActiveTasksByAgent: async () => tasks,
    updateAgentMeta: async (id, patch) => {
      calls.meta.push([id, patch])
      Object.assign(agentRow.metadata, patch.merge ? patch.merge : patch)
      if (patch.never_joined_verdicts) agentRow.metadata.never_joined_verdicts = patch.never_joined_verdicts
    },
  }
  const entry = mailboxEntry === null ? null : { kind: 'spawn', id: 'mb-1', status: 'pending', ownerId: 'fleet:mb-owner', meta: { agentId: 'fleet:test', name: 'test' }, ...mailboxEntry }
  const mailbox = {
    entries: { all: () => (entry ? [entry] : []) },
    fail: (id, error, result) => {
      if (!entry || entry.id !== id || entry.status !== 'pending') return null
      entry.status = 'failed'
      return entry
    },
    indeterminate: (id, error, result) => {
      if (!entry || entry.id !== id || entry.status !== 'pending') return null
      entry.status = 'indeterminate'
      return entry
    },
  }
  const deps = {
    store,
    mailbox,
    chat: async (from, to, text, metadata) => { calls.chats.push({ from, to, text, metadata }) },
    completeMailbox: (e, status, detail) => { calls.completions.push({ entryId: e?.id || null, status, detail }) },
    log: { warn: () => {} },
  }
  return { deps, calls, agentRow, entry }
}

function verdict(overrides = {}) {
  return {
    type: 'never-joined',
    verdict: 'absent',
    agent_id: 'fleet:test',
    mint_id: 'mint-1',
    daemon_key: 'mini:testing',
    observed: { session: 'fleet-test', runtime: false, probed: true, checked_at: '2026-09-27T00:00:00.000Z' },
    reason: 'process confirmed gone for unjoined mint',
    ...overrides,
  }
}

test('absent on a live owned row retires, records, and notifies', async () => {
  const { deps, calls } = harness()
  const outcome = await admitNeverJoinedVerdict(deps, verdict())
  assert.equal(outcome.changed, true)
  assert.deepEqual(calls.retired, ['fleet:test'])
  assert.equal(calls.completions.length, 1)
  assert.equal(calls.completions[0].status, 'failed')
  assert.equal(calls.chats.length, 1)
  assert.equal(calls.chats[0].to, 'fleet:owner')
  assert.match(calls.chats[0].text, /never joined and its process is gone/)
  assert.equal(calls.chats[0].metadata.type, 'spawn_never_joined')
  const marker = calls.meta.find(([, patch]) => patch.never_joined_verdicts)
  assert.equal(marker[1].never_joined_verdicts.absent.mint_id, 'mint-1')
})

test('duplicate (mint, verdict) changes nothing', async () => {
  const agent = liveAgent({ metadata: { shell: true, spawn_daemon_key: 'mini:testing', daemon_mint_id: 'mint-1', never_joined_verdicts: { absent: { mint_id: 'mint-1', ts: 't' } } } })
  const { deps, calls } = harness({ agent })
  const outcome = await admitNeverJoinedVerdict(deps, verdict())
  assert.equal(outcome.duplicate, true)
  assert.equal(outcome.changed, false)
  assert.deepEqual(calls.retired, [])
  assert.deepEqual(calls.chats, [])
  assert.deepEqual(calls.completions, [])
})

test('foreign daemon_key is rejected without effect', async () => {
  const { deps, calls } = harness()
  const outcome = await admitNeverJoinedVerdict(deps, verdict({ daemon_key: 'air:testing' }))
  assert.equal(outcome.ignored, 'ownership')
  assert.deepEqual(calls.retired, [])
  assert.deepEqual(calls.chats, [])
  assert.deepEqual(calls.meta, [])
})

test('legacy row without spawn key admits via matching route', async () => {
  const agent = liveAgent({ metadata: { shell: true, daemon_mint_id: 'mint-1' } })
  const { deps, calls } = harness({ agent, route: { agent_id: 'fleet:test', daemon_key: 'mini:testing' } })
  const outcome = await admitNeverJoinedVerdict(deps, verdict())
  assert.equal(outcome.changed, true)
  assert.deepEqual(calls.retired, ['fleet:test'])
})

test('legacy row with no route is rejected', async () => {
  const agent = liveAgent({ metadata: { shell: true, daemon_mint_id: 'mint-1' } })
  const { deps, calls } = harness({ agent, route: null })
  const outcome = await admitNeverJoinedVerdict(deps, verdict())
  assert.equal(outcome.ignored, 'ownership')
  assert.deepEqual(calls.retired, [])
})

test('null agent_id resolves via mint linkage', async () => {
  const { deps, calls } = harness()
  const outcome = await admitNeverJoinedVerdict(deps, verdict({ agent_id: null }))
  assert.equal(outcome.changed, true)
  assert.deepEqual(calls.retired, ['fleet:test'])
})

test('unknown agent is ignored', async () => {
  const { deps, calls } = harness({ agent: null })
  const outcome = await admitNeverJoinedVerdict(deps, verdict({ agent_id: 'fleet:ghost', mint_id: 'mint-ghost' }))
  assert.equal(outcome.ignored, 'unknown-agent')
  assert.deepEqual(calls.retired, [])
})

test('absent on a dead row marks without notice', async () => {
  const agent = liveAgent({ dead: 1 })
  const { deps, calls } = harness({ agent })
  const outcome = await admitNeverJoinedVerdict(deps, verdict())
  assert.equal(outcome.changed, false)
  assert.deepEqual(calls.chats, [])
  assert.deepEqual(calls.retired, [])
  assert.equal(calls.meta.length, 1, 'the verdict marker is still written')
})

test('leaked-alive records and notifies without retiring', async () => {
  const { deps, calls } = harness()
  const outcome = await admitNeverJoinedVerdict(deps, verdict({ verdict: 'leaked-alive', observed: { session: 'fleet-test', runtime: true, probed: true, checked_at: 't' } }))
  assert.equal(outcome.changed, true)
  assert.deepEqual(calls.retired, [])
  assert.equal(calls.completions.length, 1)
  assert.equal(calls.completions[0].status, 'indeterminate')
  assert.equal(calls.chats.length, 1)
  assert.match(calls.chats[0].text, /alive but never joined/)
  assert.match(calls.chats[0].text, /fleet-test/)
})

test('malformed verdicts are ignored', async () => {
  const { deps, calls } = harness()
  for (const bad of [
    verdict({ verdict: 'maybe' }),
    verdict({ mint_id: null }),
    verdict({ observed: { session: null } }),
    verdict({ observed: null }),
  ]) {
    const outcome = await admitNeverJoinedVerdict(deps, bad)
    assert.equal(outcome.ignored, 'shape')
  }
  assert.deepEqual(calls.retired, [])
  assert.deepEqual(calls.chats, [])
})

test('no resolvable owner records without addressing', async () => {
  const { deps, calls } = harness({ tasks: [], mailboxEntry: null })
  const outcome = await admitNeverJoinedVerdict(deps, verdict({ verdict: 'leaked-alive', observed: { session: 'fleet-test', runtime: true, probed: true, checked_at: 't' } }))
  assert.equal(outcome.changed, true)
  assert.deepEqual(calls.chats, [])
  assert.equal(calls.completions.length, 1, 'the record is still written')
})

test('changed verdict for the same mint processes', async () => {
  const agent = liveAgent({ metadata: { shell: true, spawn_daemon_key: 'mini:testing', daemon_mint_id: 'mint-1', never_joined_verdicts: { 'leaked-alive': { mint_id: 'mint-1', ts: 't' } } } })
  const { deps, calls } = harness({ agent })
  const outcome = await admitNeverJoinedVerdict(deps, verdict())
  assert.equal(outcome.changed, true)
  assert.deepEqual(calls.retired, ['fleet:test'])
})

test('F3 notice prefers the live route over the spawn key', async () => {
  const sent = []
  const agent = liveAgent({ metadata: { shell: true, spawn_daemon_key: 'mini:testing' } })
  const deps = {
    store: {
      getAgent: async () => agent,
      getAgentDaemonRoute: async () => ({ agent_id: agent.id, daemon_key: 'air:testing' }),
    },
    send: async (...args) => { sent.push(args) },
    log: { warn: () => {} },
  }
  assert.equal(await notifyOwningDaemonOfFailure(deps, agent.id, 'launch-failed'), true)
  assert.deepEqual(sent, [['air:testing', 'launch-failed-server-side', { agent_id: agent.id, reason: 'launch-failed' }]])
})

test('F3 notice falls back to the spawn key without a route', async () => {
  const sent = []
  const agent = liveAgent({ metadata: { shell: true, spawn_daemon_key: 'mini:testing' } })
  const deps = {
    store: { getAgent: async () => agent, getAgentDaemonRoute: async () => null },
    send: async (...args) => { sent.push(args) },
    log: { warn: () => {} },
  }
  assert.equal(await notifyOwningDaemonOfFailure(deps, agent.id, 'cap-refused'), true)
  assert.equal(sent[0][0], 'mini:testing')
})

test('F3 notice with no resolvable daemon sends nothing', async () => {
  const sent = []
  const agent = liveAgent({ metadata: { shell: true } })
  const deps = {
    store: { getAgent: async () => agent, getAgentDaemonRoute: async () => null },
    send: async (...args) => { sent.push(args) },
    log: { warn: () => {} },
  }
  assert.equal(await notifyOwningDaemonOfFailure(deps, agent.id, 'x'), false)
  assert.deepEqual(sent, [])
})

test('F3 notice never rejects: send and store failures return false', async () => {
  const agent = liveAgent()
  const throwingSend = {
    store: { getAgent: async () => agent, getAgentDaemonRoute: async () => ({ daemon_key: 'mini:testing' }) },
    send: async () => { throw new Error('daemon down') },
    log: { warn: () => {} },
  }
  assert.equal(await notifyOwningDaemonOfFailure(throwingSend, agent.id, 'x'), false)
  const throwingStore = {
    store: { getAgent: async () => { throw new Error('db locked') } },
    send: async () => {},
    log: { warn: () => {} },
  }
  assert.equal(await notifyOwningDaemonOfFailure(throwingStore, agent.id, 'x'), false)
})

test('findAgentByDaemonMintId resolves the shell row on a real store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-mint-link-'))
  const store = new FleetStore(join(dir, 'fleet.db'))
  try {
    store.upsertAgent({ id: 'fleet:linked', friendly_name: 'linked', metadata: { shell: true, daemon_mint_id: 'mint-abc' } })
    store.upsertAgent({ id: 'fleet:other', friendly_name: 'other', metadata: { shell: true } })
    assert.equal(store.findAgentByDaemonMintId('mint-abc'), 'fleet:linked')
    assert.equal(store.findAgentByDaemonMintId('mint-missing'), null)
    assert.equal(store.findAgentByDaemonMintId(null), null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
