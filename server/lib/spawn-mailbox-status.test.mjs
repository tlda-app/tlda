import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSpawnMailboxStatus } from './spawn-mailbox-status.mjs'

const NOW = 1_750_000_000_000

function liveRow() {
  return { id: 'fleet:abc', friendly_name: 'agent-x', dead: false, metadata: { shell: null } }
}

test('an unknown id is a status, not an error', async () => {
  const status = await buildSpawnMailboxStatus(undefined, { nowMs: NOW })
  assert.equal(status.mailbox_id, undefined)
  assert.equal(status.status, 'unknown')
})

test('a pending mailbox reports the request and the bound', async () => {
  const status = await buildSpawnMailboxStatus({
    id: 'mailbox:1',
    kind: 'spawn',
    status: 'pending',
    startedAt: NOW - 20_000,
    deadlineAt: NOW + 280_000,
    meta: { name: 'agent-x', agentId: 'fleet:abc' },
  }, { nowMs: NOW })
  assert.equal(status.status, 'pending')
  assert.equal(status.agent_id, 'fleet:abc')
  assert.equal(status.requested_name, 'agent-x')
  assert.equal(status.waited_ms, 20_000)
  assert.equal(status.remaining_ms, 280_000)
})

test('a completed mailbox carries the assignment and the live cross-check', async () => {
  const status = await buildSpawnMailboxStatus({
    id: 'mailbox:1',
    kind: 'spawn',
    status: 'completed',
    startedAt: NOW - 20_000,
    meta: { name: 'agent-x', agentId: 'fleet:abc' },
    result: { agentId: 'fleet:abc', assigned_name: 'agent-x-jr', requested_name: 'agent-x', name_changed: true, task_id: 'task-9' },
  }, { nowMs: NOW, findAgent: async () => liveRow() })
  assert.equal(status.status, 'completed')
  assert.equal(status.assigned_name, 'agent-x-jr')
  assert.equal(status.name_changed, true)
  assert.equal(status.task_id, 'task-9')
  assert.equal(status.live.state, 'live')
  assert.equal(status.live.pending, false)
})

test('a completed mailbox with a dead or missing row says the divergence', async () => {
  const dead = await buildSpawnMailboxStatus({
    id: 'mailbox:1', status: 'completed', startedAt: NOW - 20_000,
    meta: { name: 'agent-x', agentId: 'fleet:abc' }, result: { agentId: 'fleet:abc', assigned_name: 'agent-x' },
  }, { nowMs: NOW, findAgent: async () => ({ ...liveRow(), dead: true }) })
  assert.equal(dead.live.state, 'dead')
  const missing = await buildSpawnMailboxStatus({
    id: 'mailbox:1', status: 'completed', startedAt: NOW - 20_000,
    meta: { name: 'agent-x', agentId: 'fleet:abc' }, result: { agentId: 'fleet:abc', assigned_name: 'agent-x' },
  }, { nowMs: NOW, findAgent: async () => null })
  assert.equal(missing.live.state, 'missing')
})

test('a failed mailbox carries the launch error verbatim', async () => {
  const status = await buildSpawnMailboxStatus({
    id: 'mailbox:1',
    status: 'failed',
    startedAt: NOW - 20_000,
    meta: { name: 'agent-x', agentId: 'fleet:abc' },
    error: 'mint refused: 30 agents awake on mini:testing, cap is 30. Nothing was queued — this launch is declined, not deferred. Hibernate one, or raise the ceiling.',
    result: { reason: 'cap-refused' },
  }, { nowMs: NOW, findAgent: async () => null })
  assert.equal(status.status, 'failed')
  assert.match(status.error, /declined, not deferred/)
  assert.equal(status.expired, false)
})

test('a deadline-exceeded mailbox reads stuck, not slow', async () => {
  const status = await buildSpawnMailboxStatus({
    id: 'mailbox:1',
    status: 'failed',
    startedAt: NOW - 300_000,
    deadlineAt: NOW - 1_000,
    meta: { name: 'agent-x', agentId: 'fleet:abc' },
    error: 'deadline exceeded',
  }, { nowMs: NOW, findAgent: async () => null })
  assert.equal(status.status, 'failed')
  assert.equal(status.expired, true)
  assert.equal(status.reason, 'deadline-exceeded')
})

test('P2: an expired-status mailbox reads stuck, not failed', async () => {
  const status = await buildSpawnMailboxStatus({
    id: 'mailbox:1',
    status: 'expired',
    startedAt: NOW - 300_000,
    deadlineAt: NOW - 1_000,
    meta: { name: 'agent-x', agentId: 'fleet:abc' },
    error: 'deadline exceeded',
  }, { nowMs: NOW, findAgent: async () => null })
  assert.equal(status.status, 'expired')
  assert.equal(status.expired, true)
  assert.equal(status.reason, 'deadline-exceeded')
})

test('an indeterminate mailbox keeps its error and agent', async () => {
  const status = await buildSpawnMailboxStatus({
    id: 'mailbox:1',
    status: 'indeterminate',
    startedAt: NOW - 20_000,
    meta: { name: 'agent-x', agentId: 'fleet:abc' },
    error: 'spawn outcome is indeterminate after daemon restart',
    result: { reason: 'indeterminate-after-restart' },
  }, { nowMs: NOW, findAgent: async () => null })
  assert.equal(status.status, 'indeterminate')
  assert.equal(status.agent_id, 'fleet:abc')
  assert.match(status.error, /indeterminate after daemon restart/)
})
