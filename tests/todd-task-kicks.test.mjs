import assert from 'node:assert/strict'
import test from 'node:test'

import { decideTaskKicks } from '../bots/todd/kicks.mjs'

const agent = {
  id: 'fleet:worker',
  runtime_status: { status: 'awake' },
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

test('Todd task kicks keep pending chief-like work eligible beyond two hours', () => {
  const now = Date.now()
  const kicks = decideTaskKicks({
    tasks: [
      { ...task(3 * 60 * 60_000), delegated_at: new Date(now - 3 * 60 * 60_000).toISOString() },
    ],
    agents: [agent],
    now,
    quietMs: 5 * 60_000,
  })

  assert.deepEqual(kicks.map(k => k.task.id), ['task-10800000'])
})

test('Todd task kicks make unchanged pending work eligible again after cooldown', () => {
  const now = Date.now()
  const unchanged = task(30 * 60_000)
  const kicks = decideTaskKicks({
    tasks: [unchanged],
    agents: [agent],
    now,
    quietMs: 5 * 60_000,
    kickIntervalMs: 15 * 60_000,
    lastKicked: new Map([[unchanged.id, { ts: now - 16 * 60_000, sig: 'pending|awake|0' }]]),
  })

  assert.equal(kicks.length, 1)
})

test('Todd task kicks suppress an unchanged duplicate inside cooldown', () => {
  const now = Date.now()
  const unchanged = task(30 * 60_000)
  const kicks = decideTaskKicks({
    tasks: [unchanged],
    agents: [agent],
    now,
    quietMs: 5 * 60_000,
    kickIntervalMs: 15 * 60_000,
    lastKicked: new Map([[unchanged.id, { ts: now - 14 * 60_000 }]]),
  })
  assert.equal(kicks.length, 0)
})

test('Todd task kicks exclude terminal, closed, and non-owned work', () => {
  const now = Date.now()
  const tasks = [
    task(30 * 60_000, { id: 'done', status: 'done' }),
    task(31 * 60_000, { id: 'closed', status: 'closed' }),
    task(32 * 60_000, { id: 'failed', status: 'failed' }),
    task(33 * 60_000, { id: 'unowned', delegated_by: null }),
  ]
  assert.equal(decideTaskKicks({ tasks, agents: [agent], now, quietMs: 5 * 60_000 }).length, 0)
})
