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
  getAllTasks: () => tasks,
})

test('rejects authority laundered through a marker created after the target task', () => {
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')
  const launderingMarker = task('marker', 'owner', 'caller', '2026-07-23T19:51:14.000Z')

  assert.equal(canReportTask({
    caller: { id: 'caller' },
    task: target,
    fleetStore: storeWith(target, launderingMarker),
  }), false)
})

test('rejects a marker with the same delegation timestamp as the target', () => {
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')
  const launderingMarker = task('marker', 'owner', 'caller', '2026-07-20T12:00:00.000Z')

  assert.equal(canReportTask({
    caller: { id: 'caller' },
    task: target,
    fleetStore: storeWith(target, launderingMarker),
  }), false)
})

test('accepts a legitimate management chain that predates the target task', () => {
  const managerToLead = task('manager-to-lead', 'lead', 'manager', '2026-07-18T12:00:00.000Z')
  const leadToOwner = task('lead-to-owner', 'owner', 'lead', '2026-07-19T12:00:00.000Z')
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')

  assert.equal(canReportTask({
    caller: { id: 'manager' },
    task: target,
    fleetStore: storeWith(target, managerToLead, leadToOwner),
  }), true)
})

test('rejects an unrelated stranger', () => {
  const managerToOwner = task('manager-to-owner', 'owner', 'manager', '2026-07-19T12:00:00.000Z')
  const target = task('target', 'worker', 'owner', '2026-07-20T12:00:00.000Z')

  assert.equal(canReportTask({
    caller: { id: 'stranger' },
    task: target,
    fleetStore: storeWith(target, managerToOwner),
  }), false)
})
