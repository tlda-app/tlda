import assert from 'node:assert/strict'
import test from 'node:test'
import { __test, acceptSourceTransaction, activeSourceEditors, clearSourceEditsForAgent, recordSourceEditActivity } from './source-edit-activity.mjs'

test.beforeEach(() => __test.reset())

test('Edit remains active after tool completion until its exact source transaction is accepted', () => {
  const started = {
    agent_id: 'fleet:b4-live-writer',
    tool: 'Edit',
    status: 'started',
    correlationId: 'edit-1',
    project: 'bregman',
    sourceFile: 'b4-outline.md',
  }
  assert.equal(recordSourceEditActivity(started), true)
  assert.deepEqual(activeSourceEditors('bregman', 'b4-outline.md'), ['fleet:b4-live-writer'])

  assert.equal(recordSourceEditActivity({ ...started, status: 'completed' }), true)
  assert.deepEqual(activeSourceEditors('bregman', 'b4-outline.md'), ['fleet:b4-live-writer'])

  assert.equal(acceptSourceTransaction('bregman', ['b4-outline.md'], 'fleet:b4-live-writer'), true)
  assert.deepEqual(activeSourceEditors('bregman', 'b4-outline.md'), [])
})

test('agent shutdown clears an unfinished source edit session', () => {
  recordSourceEditActivity({
    agent_id: 'fleet:b4-live-writer',
    tool: 'Edit',
    status: 'started',
    correlationId: 'edit-crashed',
    project: 'bregman',
    sourceFile: 'b4-outline.md',
  })
  clearSourceEditsForAgent('fleet:b4-live-writer')
  assert.deepEqual(activeSourceEditors('bregman', 'b4-outline.md'), [])
})
