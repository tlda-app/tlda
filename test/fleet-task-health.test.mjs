import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyTaskAgentHealth } from '../mcp-server/fleet-tools.mjs'

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
  assert.match(health.managerAction, /my_task/)
})

test('task health treats recent active assignees as healthy', () => {
  const health = classifyTaskAgentHealth(task(), agent(), { nowMs })

  assert.equal(health.code, 'healthy')
  assert.equal(health.level, 'ok')
})
