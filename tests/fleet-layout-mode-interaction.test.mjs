import assert from 'node:assert/strict'
import test from 'node:test'

import { isFleetLayoutInteractionActive } from '../src/overlays/fleet-layout-mode.ts'

function editor({
  path = 'select.idle',
  isPointing = false,
  isDragging = false,
  brush = null,
} = {}) {
  return {
    getPath: () => path,
    getInstanceState: () => ({ brush }),
    inputs: { isPointing, isDragging },
  }
}

test('idle layout mode can exit when fleet selection is empty', () => {
  assert.equal(isFleetLayoutInteractionActive(editor()), false)
})

test('layout mode stays active while a brush selection is in progress', () => {
  assert.equal(isFleetLayoutInteractionActive(editor({ path: 'select.brushing' })), true)
  assert.equal(isFleetLayoutInteractionActive(editor({ brush: { x: 10, y: 20, w: 100, h: 100 } })), true)
})

test('layout mode stays active through pointer gestures before idle reconciliation', () => {
  assert.equal(isFleetLayoutInteractionActive(editor({ isPointing: true })), true)
  assert.equal(isFleetLayoutInteractionActive(editor({ isDragging: true })), true)
})
