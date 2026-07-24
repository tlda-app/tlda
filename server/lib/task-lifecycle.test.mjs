import assert from 'node:assert/strict'
import test from 'node:test'

import { canReportTask } from './task-lifecycle.mjs'

const task = (id, agent, delegatedBy, delegatedAt) => ({
  id,
  agent,
  delegated_by: delegatedBy,
  delegated_at: delegatedAt,
})

const storeWith = (...tasks) => ({
  getActiveTasks: () => tasks,
})

test('intentionally grants authority through an active post-target marker', () => {
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')
  const marker = task('marker', 'owner', 'caller', '2026-07-23T19:51:14.000Z')

  assert.equal(canReportTask({
    caller: { id: 'caller' },
    task: target,
    fleetStore: storeWith(target, marker),
  }), true)
})

test('grants authority through an active legitimate management chain', () => {
  const managerToLead = task('manager-to-lead', 'lead', 'manager', '2026-07-23T12:00:00.000Z')
  const leadToOwner = task('lead-to-owner', 'owner', 'lead', '2026-07-23T13:00:00.000Z')
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')

  assert.equal(canReportTask({
    caller: { id: 'manager' },
    task: target,
    fleetStore: storeWith(target, managerToLead, leadToOwner),
  }), true)
})

test('rejects an unrelated caller without an active management chain', () => {
  const managerToOwner = task('manager-to-owner', 'owner', 'manager', '2026-07-23T12:00:00.000Z')
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')

  assert.equal(canReportTask({
    caller: { id: 'stranger' },
    task: target,
    fleetStore: storeWith(target, managerToOwner),
  }), false)
})
