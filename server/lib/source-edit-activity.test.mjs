import assert from 'node:assert/strict'
import test from 'node:test'
import { activeSourceEditors, clearSourceEditsForAgent, recordSourceEditActivity } from './source-edit-activity.mjs'

test('Edit tool lifetime is the active source-edit session for its exact file', () => {
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
