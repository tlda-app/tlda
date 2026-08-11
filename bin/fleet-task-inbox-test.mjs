import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inboxTaskTransfer,
  projectOwnedFleetTasks,
} from '../src/shapes/fleet-task-inbox.mjs'

test('owned active tasks are projected into the inbox without truncating criteria', () => {
  const projected = projectOwnedFleetTasks([
    { id: 'mine', agent: 'fleet:skip', status: 'pending', description: 'Mine', success_criteria: ['one', 'two'] },
    { id: 'other', agent: 'fleet:other', status: 'pending', description: 'Other' },
    { id: 'done', agent: 'fleet:skip', status: 'done', description: 'Done' },
  ], 'fleet:skip')
  assert.deepEqual(projected.map(task => task.id), ['mine'])
  assert.deepEqual(projected[0].criteria, ['one', 'two'])
})

test('task-row assignment transfers the existing task as the signed-in human', () => {
  assert.deepEqual(
    inboxTaskTransfer({ id: 'mine' }, 'app-tester', 'fleet:skip', 'Skip'),
    {
      from: 'fleet:skip',
      agent: 'app-tester',
      task_id: 'mine',
      message: 'Assigned from the inbox by Skip.',
    },
  )
})
