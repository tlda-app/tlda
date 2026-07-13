import assert from 'node:assert/strict'
import test from 'node:test'

import { decideTaskKicks } from '../bots/todd/kicks.mjs'

const agent = {
  id: 'fleet:worker',
  status: 'awake',
  dead: false,
  human: false,
}

function task(ageMs, extra = {}) {
  return {
    id: `task-${ageMs}`,
    agent: agent.id,
    status: 'pending',
    delegated_by: 'fleet:chief',
    delegated_at: new Date(Date.now() - ageMs).toISOString(),
    ...extra,
  }
}

test('Todd task kicks suppress stale backlog outside the configured horizon', () => {
  const now = Date.now()
  const kicks = decideTaskKicks({
    tasks: [
      { ...task(30 * 60_000), delegated_at: new Date(now - 30 * 60_000).toISOString() },
      { ...task(3 * 60 * 60_000), delegated_at: new Date(now - 3 * 60 * 60_000).toISOString() },
    ],
    agents: [agent],
    now,
    maxTaskAgeMs: 2 * 60 * 60_000,
    quietMs: 5 * 60_000,
  })

  assert.deepEqual(kicks.map(k => k.task.id), ['task-1800000'])
})

test('Todd task kicks still allow an explicit longer horizon', () => {
  const now = Date.now()
  const kicks = decideTaskKicks({
    tasks: [
      { ...task(3 * 60 * 60_000), delegated_at: new Date(now - 3 * 60 * 60_000).toISOString() },
    ],
    agents: [agent],
    now,
    maxTaskAgeMs: 4 * 60 * 60_000,
    quietMs: 5 * 60_000,
  })

  assert.equal(kicks.length, 1)
})
