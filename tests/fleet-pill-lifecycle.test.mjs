import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelDragBeforeRelease,
  finishFleetPillTranslation,
} from '../src/shapes/fleet-pill-lifecycle.ts'

test('translation cleanup restores snap state and deletes the pill exactly once', () => {
  const pillId = 'shape:pill'
  let exists = true
  const deleted = []
  const preferences = []
  const editor = {
    getShape: (id) => exists && id === pillId ? { id } : undefined,
    deleteShapes: (ids) => {
      deleted.push(...ids)
      exists = false
    },
    user: {
      updateUserPreferences: (next) => preferences.push(next),
    },
  }
  const snapState = {
    deltaX: 7,
    deltaY: 9,
    lines: [{ axis: 'x', pos: 3 }],
    active: true,
    expanded: true,
    prevSnapMode: false,
  }

  finishFleetPillTranslation(editor, pillId, snapState)
  finishFleetPillTranslation(editor, pillId, snapState)

  assert.deepEqual(preferences, [{ isSnapMode: false }])
  assert.deepEqual(deleted, [pillId])
  assert.deepEqual(snapState, {
    deltaX: 0,
    deltaY: 0,
    lines: [],
    active: false,
    expanded: false,
    prevSnapMode: undefined,
  })
})

test('translation cancel defers deletion past TLDraw rollback', async () => {
  const pillId = 'shape:canceled-pill'
  let exists = true
  const deleted = []
  const editor = {
    getShape: (id) => exists && id === pillId ? { id } : undefined,
    deleteShapes: (ids) => {
      deleted.push(...ids)
      exists = false
    },
    user: { updateUserPreferences: () => {} },
  }
  const snapState = {
    deltaX: 0,
    deltaY: 0,
    lines: [],
    active: true,
    expanded: false,
    prevSnapMode: undefined,
  }

  finishFleetPillTranslation(editor, pillId, snapState, { deferDelete: true })
  assert.deepEqual(deleted, [])

  // TLDraw's cancel path rolls back synchronously after the hook returns.
  exists = true
  await Promise.resolve()
  assert.deepEqual(deleted, [pillId])
})

test('chat teardown cancels its drag before releasing coordinator ownership', () => {
  const calls = []
  cancelDragBeforeRelease(
    () => calls.push('cancel'),
    () => calls.push('release'),
  )
  assert.deepEqual(calls, ['cancel', 'release'])
})
