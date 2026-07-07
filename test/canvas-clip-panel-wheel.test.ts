import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canvasClipWheelCamera, isCanvasClipWheelMessage } from '../src/canvas-clip-wheel.ts'

test('clip wheel boundary accepts only messages for its viewport and requested shapes', () => {
  const requested = new Set(['shape:html-page-1'])
  assert.equal(isCanvasClipWheelMessage({
    type: 'tlda-clip-wheel',
    viewportId: 'clip-panel-123',
    shapeId: 'shape:html-page-1',
  }, 'clip-panel-123', requested), true)
  assert.equal(isCanvasClipWheelMessage({
    type: 'tlda-wheel',
    viewportId: 'clip-panel-123',
    shapeId: 'shape:html-page-1',
  }, 'clip-panel-123', requested), false)
  assert.equal(isCanvasClipWheelMessage({
    type: 'tlda-clip-wheel',
    viewportId: 'other',
    shapeId: 'shape:html-page-1',
  }, 'clip-panel-123', requested), false)
  assert.equal(isCanvasClipWheelMessage({
    type: 'tlda-clip-wheel',
    viewportId: 'clip-panel-123',
    shapeId: 'shape:other',
  }, 'clip-panel-123', requested), false)
})

test('annotation viewer iframe wheel deltas pan the clipped camera, not the main canvas camera path', () => {
  const next = canvasClipWheelCamera(
    { x: -100, y: -200, z: 2 },
    20,
    40,
    { x: 0, y: 0, w: 800, h: 1200 },
    400,
    300,
  )

  assert.equal(next.x, -110)
  assert.equal(next.y, -220)
  assert.equal(next.z, 2)
})

test('annotation viewer iframe wheel camera is clamped to the clipped bounds', () => {
  const next = canvasClipWheelCamera(
    { x: 0, y: 0, z: 1 },
    -200,
    -200,
    { x: 0, y: 0, w: 800, h: 1200 },
    400,
    300,
  )

  assert.equal(next.x, 0)
  assert.equal(next.y, 0)
})

test('annotation viewer ctrl wheel zooms the clipped camera', () => {
  const next = canvasClipWheelCamera(
    { x: -100, y: -200, z: 1 },
    0,
    -100,
    { x: 0, y: 0, w: 1200, h: 1600 },
    400,
    300,
    { zoom: true },
  )

  assert.ok(next.z > 1)
  assert.notEqual(next.x, -100)
  assert.notEqual(next.y, -200)
})
