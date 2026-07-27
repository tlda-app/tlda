import assert from 'node:assert/strict'
import test from 'node:test'

import { appendDelegationMessage, canReportTask, transferTaskLifecycle } from './task-lifecycle.mjs'

const task = (id, agent, delegatedBy, delegatedAt) => ({
  id,
  agent,
  delegated_by: delegatedBy,
  delegated_at: delegatedAt,
})

const storeWith = (...tasks) => ({
  getActiveTasks: () => tasks,
})

test('intentionally grants authority through an active post-target marker', async () => {
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')
  const marker = task('marker', 'owner', 'caller', '2026-07-23T19:51:14.000Z')

  assert.equal(await canReportTask({
    caller: { id: 'caller' },
    task: target,
    fleetStore: storeWith(target, marker),
  }), true)
})

test('grants authority through an active legitimate management chain', async () => {
  const managerToLead = task('manager-to-lead', 'lead', 'manager', '2026-07-23T12:00:00.000Z')
  const leadToOwner = task('lead-to-owner', 'owner', 'lead', '2026-07-23T13:00:00.000Z')
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')

  assert.equal(await canReportTask({
    caller: { id: 'manager' },
    task: target,
    fleetStore: storeWith(target, managerToLead, leadToOwner),
  }), true)
})

test('rejects an unrelated caller without an active management chain', async () => {
  const managerToOwner = task('manager-to-owner', 'owner', 'manager', '2026-07-23T12:00:00.000Z')
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')

  assert.equal(await canReportTask({
    caller: { id: 'stranger' },
    task: target,
    fleetStore: storeWith(target, managerToOwner),
  }), false)
})

test('appends existing-task delegation text without replacing the original brief', () => {
  const original = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')
  original.description = 'Original subject'
  original.message = 'Original assignment text.'

  const message = appendDelegationMessage(original, {
    fromAgentId: 'worker',
    toAgentId: 'next',
    delegatedAt: '2026-07-25T12:00:00.000Z',
    message: 'Continue with the remaining verification.',
  })

  assert.match(message, /Original assignment text\./)
  assert.match(message, /Delegated to next/)
  assert.match(message, /From: worker/)
  assert.match(message, /Continue with the remaining verification\./)
  assert.ok(message.indexOf('Original assignment text.') < message.indexOf('Continue with the remaining verification.'))
})

test('transfers a task by keeping its id and appending the delegation message', async () => {
  const original = {
    ...task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z'),
    description: 'Original subject',
    message: 'Original assignment text.',
    status: 'working',
  }
  let storedTask = null
  let delegateCall = null
  const fleetStore = {
    upsertTask: t => { storedTask = t },
    delegate: async (from, to, taskId, description, metadata) => {
      delegateCall = { from, to, taskId, description, metadata }
      return { id: 42 }
    },
  }

  const result = await transferTaskLifecycle({
    fleetStore,
    task: original,
    fromAgentId: 'worker',
    toAgentId: 'next',
    delegatedAt: '2026-07-25T12:00:00.000Z',
    message: 'Continue with the remaining verification.',
    eventMetadata: { transfer: true },
  })

  assert.equal(result.eventId, 42)
  assert.equal(storedTask.id, 'target')
  assert.equal(storedTask.agent, 'next')
  assert.equal(storedTask.status, 'working')
  assert.equal(storedTask.delegated_by, 'owner')
  assert.equal(storedTask.delegated_at, '2026-07-20T12:00:00.000Z')
  assert.match(storedTask.message, /Original assignment text\./)
  assert.match(storedTask.message, /Continue with the remaining verification\./)
  assert.deepEqual(delegateCall, {
    from: 'worker',
    to: 'next',
    taskId: 'target',
    description: 'Original subject',
    metadata: { transfer: true },
  })
})
