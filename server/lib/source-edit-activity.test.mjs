import assert from 'node:assert/strict'
import test from 'node:test'
import { __test, activeSourceEditors, clearSourceEditsForAgent, recordSourceEditActivity, recordSourceEditTurnEnded } from './source-edit-activity.mjs'

test.beforeEach(() => __test.reset())

test('Edit remains active after tool completion and accepted source reconciliation until agent idle', () => {
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

  // Source acceptance updates edit history but is not the agent-session boundary.
  assert.deepEqual(activeSourceEditors('bregman', 'b4-outline.md'), ['fleet:b4-live-writer'])

  recordSourceEditTurnEnded('fleet:b4-live-writer')
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
