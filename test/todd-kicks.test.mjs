import assert from 'node:assert/strict'
import test from 'node:test'

import { decideTaskKicks, formatTaskKickMessage } from '../bin/lib/todd-kicks.mjs'

const now = Date.parse('2026-06-18T10:00:00.000Z')

function task(overrides = {}) {
  return {
    id: 'task-1',
    agent: 'fleet:agent-1',
    description: 'Do the thing',
    delegated_at: new Date(now - 10 * 60_000).toISOString(),
    status: 'pending',
    ...overrides,
  }
}

function agent(overrides = {}) {
  return {
    id: 'fleet:agent-1',
    friendly_name: 'agent-1',
    status: 'awake',
    last_seen: new Date(now - 10 * 60_000).toISOString(),
    ...overrides,
  }
}

test('task kick selects awake quiet agents with active non-stale tasks', () => {
  const kicks = decideTaskKicks({
    tasks: [task()],
    agents: [agent()],
    now,
  })

  assert.equal(kicks.length, 1)
  assert.equal(kicks[0].key, 'task-1')
})

test('task kick recovers hibernating agents but skips stale backlog tasks', () => {
  const hibernating = decideTaskKicks({
    tasks: [task()],
    agents: [agent({ status: 'hibernating' })],
    now,
  })
  assert.equal(hibernating.length, 1)
  assert.equal(hibernating[0].action, 'respawn')
  assert.equal(hibernating[0].reason, 'hibernating-active-task')

  assert.equal(decideTaskKicks({
    tasks: [task({ delegated_at: new Date(now - 25 * 60 * 60_000).toISOString() })],
    agents: [agent()],
    now,
  }).length, 0)
})

test('task kick skips recently active agents and respects per-task cooldown', () => {
  assert.equal(decideTaskKicks({
    tasks: [task()],
    agents: [agent({ last_seen: new Date(now - 60_000).toISOString() })],
    now,
  }).length, 0)

  assert.equal(decideTaskKicks({
    tasks: [task()],
    agents: [agent()],
    now,
    lastKicked: new Map([['task-1', now - 60_000]]),
  }).length, 0)
})

test('task kick message includes loose-end self-check', () => {
  const message = formatTaskKickMessage({
    task: task(),
    taskAgeMs: 10 * 60_000,
  })

  assert.match(message, /are there loose ends you can track down yourself/i)
  assert.match(message, /report a true blocker with evidence/i)
})
