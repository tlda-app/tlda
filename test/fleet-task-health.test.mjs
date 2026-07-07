import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TASK_HEALTH_ACTIONABLE_MAX_AGE_MS,
  classifyTaskAgentHealth,
  classifyTaskListHealthBucket,
  summarizeTaskListHealth,
} from '../mcp-server/fleet-tools.mjs'

const nowMs = Date.parse('2026-06-18T12:00:00.000Z')

function task(overrides = {}) {
  return {
    id: 'task-1',
    agent: 'fleet:reviewer',
    description: 'Review the proof',
    delegated_at: new Date(nowMs - 10 * 60_000).toISOString(),
    status: 'working',
    ...overrides,
  }
}

function agent(overrides = {}) {
  return {
    id: 'fleet:reviewer',
    friendly_name: 'reviewer',
    status: 'awake',
    last_seen: new Date(nowMs - 60_000).toISOString(),
    ...overrides,
  }
}

test('task health flags missing or stopped assignees', () => {
  assert.equal(classifyTaskAgentHealth(task(), null, { nowMs }).code, 'missing-agent')
  assert.equal(classifyTaskAgentHealth(task(), agent({ dead: true }), { nowMs }).code, 'dead-agent')
  assert.equal(classifyTaskAgentHealth(task(), agent({ status: 'hibernating' }), { nowMs }).code, 'hibernating-agent')
})

test('task health flags stale reviewer heartbeat', () => {
  const health = classifyTaskAgentHealth(task(), agent({
    last_seen: new Date(nowMs - 15 * 60_000).toISOString(),
  }), {
    nowMs,
    aliveThresholdMs: 10 * 60_000,
  })

  assert.equal(health.code, 'stale-heartbeat')
  assert.match(health.text, /15m/)
})

test('task health flags tasks not picked up after grace', () => {
  const health = classifyTaskAgentHealth(task({ status: 'pending' }), agent(), {
    nowMs,
    pickupGraceMs: 2 * 60_000,
  })

  assert.equal(health.code, 'pending-pickup')
  assert.match(health.managerAction, /inbox/)
})

test('task health treats recent active assignees as healthy', () => {
  const health = classifyTaskAgentHealth(task(), agent(), { nowMs })

  assert.equal(health.code, 'healthy')
  assert.equal(health.level, 'ok')
})

test('task list health keeps current missing or hibernating tasks actionable', () => {
  const missingHealth = classifyTaskAgentHealth(task(), null, { nowMs })
  const missingBucket = classifyTaskListHealthBucket(task(), missingHealth, { nowMs })
  assert.equal(missingBucket.kind, 'actionable')

  const hibernatingHealth = classifyTaskAgentHealth(task(), agent({ status: 'hibernating' }), { nowMs })
  const hibernatingBucket = classifyTaskListHealthBucket(task(), hibernatingHealth, { nowMs })
  assert.equal(hibernatingBucket.kind, 'actionable')
})

test('task list health counts old missing or hibernating tasks as stale backlog', () => {
  const oldTask = task({
    delegated_at: new Date(nowMs - TASK_HEALTH_ACTIONABLE_MAX_AGE_MS - 60_000).toISOString(),
  })

  const missingHealth = classifyTaskAgentHealth(oldTask, null, { nowMs })
  const missingBucket = classifyTaskListHealthBucket(oldTask, missingHealth, { nowMs })
  assert.equal(missingHealth.code, 'missing-agent')
  assert.equal(missingBucket.kind, 'stale-backlog')

  const hibernatingHealth = classifyTaskAgentHealth(oldTask, agent({ status: 'hibernating' }), { nowMs })
  const hibernatingBucket = classifyTaskListHealthBucket(oldTask, hibernatingHealth, { nowMs })
  assert.equal(hibernatingHealth.code, 'hibernating-agent')
  assert.equal(hibernatingBucket.kind, 'stale-backlog')
})

test('task list health summary splits active warnings from stale backlog cleanup', () => {
  const oldMissing = task({
    id: 'old-missing',
    agent: 'fleet:missing-old',
    delegated_at: new Date(nowMs - TASK_HEALTH_ACTIONABLE_MAX_AGE_MS - 60_000).toISOString(),
  })
  const oldHibernating = task({
    id: 'old-hibernating',
    delegated_at: new Date(nowMs - TASK_HEALTH_ACTIONABLE_MAX_AGE_MS - 60_000).toISOString(),
  })
  const currentMissing = task({
    id: 'current-missing',
    agent: 'fleet:missing-current',
  })
  const healthyCurrent = task({ id: 'healthy-current', agent: 'fleet:healthy' })
  const agents = new Map([
    ['fleet:reviewer', agent({ status: 'hibernating' })],
    ['fleet:healthy', agent({ id: 'fleet:healthy' })],
  ])

  const summary = summarizeTaskListHealth([
    oldMissing,
    oldHibernating,
    currentMissing,
    healthyCurrent,
  ], agents, { nowMs })

  assert.equal(summary.actionableUnhealthy.length, 1)
  assert.equal(summary.actionableUnhealthy[0].health.code, 'missing-agent')
  assert.equal(summary.staleBacklogUnhealthy.length, 2)
  assert.deepEqual(
    summary.staleBacklogUnhealthy.map(b => b.health.code).sort(),
    ['hibernating-agent', 'missing-agent'],
  )
})
