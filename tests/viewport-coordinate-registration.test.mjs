import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EDITOR_WM_ROOT_LAYER_ID,
  registerViewportLayer,
  unregisterViewportLayer,
  viewportCoordinateLayerId,
  viewportFrameLayerId,
} from '../src/wm/editor-wm.ts'
import { createWMCore } from '../src/wm/wm-core.ts'
import { clientPointToPage } from '../src/wm/viewport-coordinates.ts'

test('clientPointToPage uses registered WM viewport coordinates before tldraw fallback', () => {
  const viewportId = 'hud:test'
  const editor = {
    screenToPage: () => ({ x: -1, y: -1 }),
  }
  const wm = createWMCore({ rootLayerId: EDITOR_WM_ROOT_LAYER_ID })
  const frameLayerId = viewportFrameLayerId(viewportId)
  const coordinateLayerId = viewportCoordinateLayerId(viewportId)
  wm.defineLayer(frameLayerId, {
    parent: EDITOR_WM_ROOT_LAYER_ID,
    transform: { x: 100, y: 50, scale: 1 },
  })
  wm.defineLayer(coordinateLayerId, {
    parent: frameLayerId,
    transform: { x: 10, y: 5, scale: 2 },
  })
  const registration = {
    viewportId,
    wm,
    frameLayerId,
    coordinateLayerId,
  }

  registerViewportLayer(editor, registration)
  try {
    assert.deepEqual(clientPointToPage(editor, { x: 130, y: 75 }, viewportId), { x: 10, y: 10 })
  } finally {
    unregisterViewportLayer(editor, viewportId, registration)
  }
})
