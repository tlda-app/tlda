// wake-base-resolved admission: ownership-verified, idempotent on the
// resolved session. Records metadata.wakeBase and parks the substitution
// announcement where login hands it over. Duplicates and foreign verdicts
// change nothing; a parked notice is appended to, never clobbered.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { admitWakeBaseResolved, wakeBaseNoticeText } from './wake-base-admission.mjs'

const RESOLVED = { kind: 'default', name: null, path: '/Users/skip/.claude/projects' }
const CONFIGURED = { path: '/Users/skip/.tlda/configs/app/claude/projects' }

function agent(overrides = {}) {
  return {
    id: 'fleet:test',
    friendly_name: 'test',
    dead: 0,
    metadata: { spawn_daemon_key: 'mini:testing' },
    ...overrides,
  }
}

function harness({ row = agent(), route = null } = {}) {
  const agentRow = row ? JSON.parse(JSON.stringify(row)) : null
  const calls = { meta: [] }
  const store = {
    getAgent: async id => (agentRow && id === agentRow.id ? agentRow : null),
    getAgentDaemonRoute: async () => route,
    updateAgentMeta: async (id, patch) => {
      calls.meta.push([id, patch])
      Object.assign(agentRow.metadata, patch)
    },
  }
  return { deps: { store, log: { warn: () => {} } }, calls, agentRow }
}

function verdict(overrides = {}) {
  return {
    type: 'wake-base-resolved',
    agent_id: 'fleet:test',
    session_id: 'sess-1',
    resolved: { ...RESOLVED },
    configured: { ...CONFIGURED },
    daemon_key: 'mini:testing',
    ts: '2026-09-28T00:00:00.000Z',
    ...overrides,
  }
}

test('owned verdict records the base and parks the announcement', async () => {
  const { deps, calls, agentRow } = harness()
  const outcome = await admitWakeBaseResolved(deps, verdict())
  assert.equal(outcome.changed, true)
  assert.equal(calls.meta.length, 1)
  const patch = calls.meta[0][1]
  assert.equal(patch.wakeBase.session_id, 'sess-1')
  assert.equal(patch.wakeBase.resolved.path, RESOLVED.path)
  assert.equal(patch.wakeBase.configured.path, CONFIGURED.path)
  assert.match(patch.pendingReturnNotice, /sess-1/)
  assert.match(patch.pendingReturnNotice, /default Claude base/)
  assert.match(patch.pendingReturnNotice, /not in play/)
  assert.equal(agentRow.metadata.wakeBase.session_id, 'sess-1')
})

test('notice names both bases', () => {
  const text = wakeBaseNoticeText({ sessionId: 'sess-1', resolved: RESOLVED, configured: CONFIGURED })
  assert.match(text, /sess-1/)
  assert.match(text, /default Claude base/)
  assert.match(text, /lane bundle is not in play/)
})

test('duplicate verdict for the same session changes nothing', async () => {
  const { deps, calls } = harness({
    row: agent({ metadata: { spawn_daemon_key: 'mini:testing', wakeBase: { session_id: 'sess-1', resolved: { ...RESOLVED } } } }),
  })
  const outcome = await admitWakeBaseResolved(deps, verdict())
  assert.equal(outcome.changed, false)
  assert.equal(outcome.duplicate, true)
  assert.equal(calls.meta.length, 0)
})

test('foreign daemon_key is rejected', async () => {
  const { deps, calls } = harness()
  const outcome = await admitWakeBaseResolved(deps, verdict({ daemon_key: 'air:testing' }))
  assert.equal(outcome.changed, false)
  assert.equal(outcome.ignored, 'ownership')
  assert.equal(calls.meta.length, 0)
})

test('rows without a spawn key fall back to the live route', async () => {
  const { deps, calls } = harness({
    row: agent({ metadata: {} }),
    route: { daemon_key: 'mini:testing' },
  })
  const outcome = await admitWakeBaseResolved(deps, verdict())
  assert.equal(outcome.changed, true)
  assert.equal(calls.meta.length, 1)
})

test('a parked notice is appended to, never clobbered', async () => {
  const { deps, calls } = harness({
    row: agent({ metadata: { spawn_daemon_key: 'mini:testing', pendingReturnNotice: 'earlier notice' } }),
  })
  const outcome = await admitWakeBaseResolved(deps, verdict())
  assert.equal(outcome.changed, true)
  const patch = calls.meta[0][1]
  assert.match(patch.pendingReturnNotice, /earlier notice/)
  assert.match(patch.pendingReturnNotice, /sess-1/)
})
