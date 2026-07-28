import test from 'node:test'
import assert from 'node:assert/strict'

import { decideTaskKicks } from '../bots/todd/kicks.mjs'

const now = Date.parse('2026-07-28T10:30:00.000Z')
const agents = [{ id: 'fleet:worker', status: 'idle' }]

function task(metadata) {
  return {
    id: 'task-1',
    agent: 'fleet:worker',
    delegated_by: 'fleet:manager',
    delegated_at: '2026-07-28T10:00:00.000Z',
    status: 'pending',
    metadata,
  }
}

test('Todd ignores a task before notify_at', () => {
  const kicks = decideTaskKicks({
    tasks: [task({ notify_at: '2026-07-28T11:00:00.000Z' })],
    agents,
    now,
    quietMs: 0,
  })

  assert.deepEqual(kicks, [])
})

test('Todd ignores a task after expires_at', () => {
  const kicks = decideTaskKicks({
    tasks: [task({ expires_at: '2026-07-28T10:15:00.000Z' })],
    agents,
    now,
    quietMs: 0,
  })

  assert.deepEqual(kicks, [])
})
