import assert from 'node:assert/strict'
import test from 'node:test'

import { appendDelegationMessage, appendTaskLifecycle, appendTaskMessage, canAppendTask, canReportTask, completeTaskLifecycle, transferTaskLifecycle } from './task-lifecycle.mjs'

const task = (id, agent, delegatedBy, delegatedAt) => ({
  id,
  agent,
  delegated_by: delegatedBy,
  delegated_at: delegatedAt,
})

const storeWith = (...tasks) => ({
  getActiveTasks: () => tasks,
})

test('successful task completion resets the agent idle clock', async () => {
  let idleSeconds = 1201
  const observedAtTaskDone = []
  const fleetStore = {
    upsertTask: async () => {},
    taskDone: async () => {
      observedAtTaskDone.push(idleSeconds)
      return { id: 17 }
    },
  }

  await completeTaskLifecycle({
    fleetStore,
    agentId: 'fleet:worker',
    task: { id: 'task:one', agent: 'fleet:worker', status: 'working' },
    onCompleted: agentId => {
      assert.equal(agentId, 'fleet:worker')
      idleSeconds = 0
    },
  })

  assert.deepEqual(observedAtTaskDone, [0])
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

test('appends a follow-up without transferring ownership', () => {
  const original = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')
  original.description = 'Original subject'
  original.message = 'Original assignment text.'

  const message = appendTaskMessage(original, {
    fromAgentId: 'owner',
    appendedAt: '2026-07-25T12:00:00.000Z',
    message: 'New requirement: also check the retirement path.',
  })

  assert.match(message, /Original assignment text\./)
  assert.match(message, /Appended by owner/)
  assert.match(message, /New requirement: also check the retirement path\./)
  assert.ok(message.indexOf('Original assignment text.') < message.indexOf('New requirement:'))
})

test('append authority is the owner, the delegator, or a human — nothing else', () => {
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')
  assert.equal(canAppendTask({ caller: { id: 'worker' }, task: target }), true)
  assert.equal(canAppendTask({ caller: { id: 'owner' }, task: target }), true)
  assert.equal(canAppendTask({ caller: { id: 'stranger', human: true }, task: target }), true)
  assert.equal(canAppendTask({ caller: { id: 'stranger' }, task: target }), false)
  assert.equal(canAppendTask({ caller: null, task: target }), false)
})

test('appending stores the follow-up and nudges an arrived owner', async () => {
  const original = {
    ...task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z'),
    description: 'Original subject',
    message: 'Original assignment text.',
    status: 'working',
  }
  let storedTask = null
  let nudged = null
  const result = await appendTaskLifecycle({
    fleetStore: { upsertTask: t => { storedTask = t } },
    task: original,
    caller: { id: 'owner' },
    message: 'New requirement.',
    ownerRow: { id: 'worker', friendly_name: 'worker', dead: false, metadata: {} },
    onNudge: (agentId, text) => { nudged = { agentId, text }; return { nudged: true } },
  })
  assert.equal(storedTask.id, 'target')
  assert.equal(storedTask.agent, 'worker')
  assert.equal(storedTask.description, 'Original subject')
  assert.match(storedTask.message, /New requirement\./)
  assert.equal(result.nudged, true)
  assert.equal(nudged.agentId, 'worker')
})

test('appending to a pending owner stores without nudging', async () => {
  const original = {
    ...task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z'),
    message: 'Original assignment text.',
    status: 'working',
  }
  let storedTask = null
  let nudgeCount = 0
  const result = await appendTaskLifecycle({
    fleetStore: { upsertTask: t => { storedTask = t } },
    task: original,
    caller: { id: 'owner' },
    message: 'New requirement.',
    ownerRow: { id: 'worker', friendly_name: 'worker', dead: false, metadata: { shell: true } },
    onNudge: () => { nudgeCount++ },
  })
  assert.match(storedTask.message, /New requirement\./)
  assert.equal(result.nudged, false)
  assert.equal(result.nudgeSkipped, 'pending')
  assert.equal(nudgeCount, 0)
})

test('a declined wake reads as not-nudged, never as nudged', async () => {
  const original = {
    ...task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z'),
    message: 'Original assignment text.',
    status: 'working',
  }
  const result = await appendTaskLifecycle({
    fleetStore: { upsertTask: () => {} },
    task: original,
    caller: { id: 'owner' },
    message: 'New requirement.',
    ownerRow: { id: 'worker', friendly_name: 'worker', dead: false, metadata: {} },
    onNudge: () => ({ nudged: false, reason: 'human-agent' }),
  })
  assert.equal(result.nudged, false)
  assert.equal(result.nudgeSkipped, 'human-agent')
})

test('appending refuses closed tasks and strangers', async () => {
  const done = { ...task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z'), status: 'done' }
  await assert.rejects(() => appendTaskLifecycle({
    fleetStore: { upsertTask: () => {} },
    task: done,
    caller: { id: 'owner' },
    message: 'Too late.',
    ownerRow: null,
  }), /closed task/)
  const open = { ...task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z'), status: 'working' }
  await assert.rejects(() => appendTaskLifecycle({
    fleetStore: { upsertTask: () => {} },
    task: open,
    caller: { id: 'stranger' },
    message: 'Sneaky.',
    ownerRow: null,
  }), /neither the owner nor the delegator/)
})

test('transfers a task by keeping its id and appending the delegation message', async () => {
  const original = {
    ...task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z'),
    description: 'Original subject',
    message: 'Original assignment text.',
    status: 'working',
    metadata: {
      keep: 'unchanged',
      at: '2026-07-25T12:00:00.000Z',
      notify_every: 300,
      expires_at: '2026-07-25T13:00:00.000Z',
    },
  }
  let storedTask = null
  let delegateCall = null
  const fleetStore = {
    upsertTask: t => { storedTask = t },
    delegate: async (from, to, taskId, description, metadata, options) => {
      delegateCall = { from, to, taskId, description, metadata, options }
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
    eventOptions: { unread: true },
    taskMetadataPatch: {
      at: '2026-07-26T12:00:00.000Z',
      notify_every: undefined,
      expires_at: undefined,
    },
  })

  assert.equal(result.eventId, 42)
  assert.equal(storedTask.id, 'target')
  assert.equal(storedTask.agent, 'next')
  assert.equal(storedTask.status, 'working')
  assert.equal(storedTask.delegated_by, 'owner')
  assert.equal(storedTask.delegated_at, '2026-07-20T12:00:00.000Z')
  // The row's own title, which is what tasks() prints. The call above passes no
  // `description`, and this is the assertion that says so: a hand-off does not
  // retitle what it hands off. The delegate event's copy was already checked
  // below, but the event is not the row -- 39 open tasks had the right subject
  // in their delegate events and a hand-off note in this field.
  assert.equal(storedTask.description, 'Original subject')
  assert.deepEqual(storedTask.metadata, {
    keep: 'unchanged',
    at: '2026-07-26T12:00:00.000Z',
  })
  assert.match(storedTask.message, /Original assignment text\./)
  assert.match(storedTask.message, /Continue with the remaining verification\./)
  assert.deepEqual(delegateCall, {
    from: 'worker',
    to: 'next',
    taskId: 'target',
    description: 'Original subject',
    metadata: { transfer: true },
    options: { unread: true },
  })
})
