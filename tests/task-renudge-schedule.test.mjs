import test from 'node:test'
import assert from 'node:assert/strict'

import { decideTaskRenudges } from '../server/lib/task-renudge.mjs'

function state(metadata) {
  return {
    task: {
      id: 'task-1',
      agent: 'fleet:worker',
      status: 'pending',
      delegated_at: '2026-07-28T10:00:00.000Z',
      metadata,
    },
    event: {
      id: 1,
      type: 'delegate',
      timestamp: '2026-07-28T10:00:00.000Z',
    },
    unreadPending: true,
  }
}

const agents = [{ id: 'fleet:worker', status: 'idle' }]

test('task renudge waits until notify_at', () => {
  const nudges = decideTaskRenudges({
    taskStates: [state({ notify_at: '2026-07-28T11:00:00.000Z' })],
    agents,
    now: Date.parse('2026-07-28T10:30:00.000Z'),
  })

  assert.deepEqual(nudges, [])
})

test('task renudge stops at expires_at', () => {
  const nudges = decideTaskRenudges({
    taskStates: [state({ expires_at: '2026-07-28T10:15:00.000Z' })],
    agents,
    now: Date.parse('2026-07-28T10:30:00.000Z'),
  })

  assert.deepEqual(nudges, [])
})
