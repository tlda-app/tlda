import assert from 'node:assert/strict'
import test from 'node:test'

import { applyFilterPreviewWithIntent } from '../src/shapes/fleet-filter-intent-telemetry.ts'

function createIntent() {
  const calls = []
  return {
    calls,
    mutationRequest(detail) { calls.push({ phase: 'mutation-request', detail }) },
    mutationCommit(detail) { calls.push({ phase: 'mutation-commit', detail }) },
    renderConfirmed(detail) { calls.push({ phase: 'render-confirmed', detail }) },
    failure(failureReason, detail) { calls.push({ phase: 'failure', failureReason, detail }) },
  }
}

function createEditor(initialFilter, { ignoreFilterUpdate = false, renderFilter } = {}) {
  const shape = {
    id: 'shape:chat-a',
    type: 'fleet-chat',
    isLocked: false,
    props: { filter: initialFilter },
  }
  return {
    shape,
    getShape(id) {
      assert.equal(id, shape.id)
      if (renderFilter !== undefined) {
        return { ...shape, props: { ...shape.props, filter: renderFilter } }
      }
      return shape
    },
    updateShape(update) {
      assert.equal(update.id, shape.id)
      if (update.isLocked !== undefined) shape.isLocked = update.isLocked
      if (update.props?.filter && !ignoreFilterUpdate) shape.props.filter = update.props.filter
    },
  }
}

test('filter intent emits commit and render confirmation only after changed matching state', () => {
  const editor = createEditor([])
  const intent = createIntent()
  const preview = [[['to', 'agent-a']]]

  const result = applyFilterPreviewWithIntent(editor, editor.shape, preview, intent, check => check())

  assert.deepEqual(result.committed, true)
  assert.deepEqual(intent.calls.map(call => call.phase), [
    'mutation-request',
    'mutation-commit',
    'render-confirmed',
  ])
  assert.equal(intent.calls[1].detail.changed, true)
  assert.notEqual(intent.calls[1].detail.stateHashBefore, intent.calls[1].detail.stateHashAfter)
})

test('filter intent emits no-state-change instead of false mutation commit', () => {
  const preview = [[['to', 'agent-a']]]
  const editor = createEditor(preview, { ignoreFilterUpdate: true })
  const intent = createIntent()

  const result = applyFilterPreviewWithIntent(editor, editor.shape, preview, intent, check => check())

  assert.deepEqual(result.committed, false)
  assert.equal(result.reason, 'no-state-change')
  assert.deepEqual(intent.calls.map(call => call.phase), [
    'mutation-request',
    'failure',
  ])
  assert.equal(intent.calls[1].failureReason, 'no-state-change')
  assert.equal(intent.calls.some(call => call.phase === 'mutation-commit'), false)
  assert.equal(intent.calls.some(call => call.phase === 'render-confirmed'), false)
})

test('filter intent emits render-mismatch instead of false render confirmation', () => {
  const editor = createEditor([])
  const intent = createIntent()
  const preview = [[['to', 'agent-a']]]
  const mismatchedRender = [[['from', 'agent-a']]]

  const result = applyFilterPreviewWithIntent(editor, editor.shape, preview, intent, check => {
    editor.shape.props.filter = mismatchedRender
    check()
  })

  assert.deepEqual(result.committed, true)
  assert.deepEqual(intent.calls.map(call => call.phase), [
    'mutation-request',
    'mutation-commit',
    'failure',
  ])
  assert.equal(intent.calls[2].failureReason, 'render-mismatch')
  assert.equal(intent.calls.some(call => call.phase === 'render-confirmed'), false)
})
