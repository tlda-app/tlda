import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const helper = readFileSync(new URL('../src/canvas-clip-wheel.ts', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/CanvasClipPanel.tsx', import.meta.url), 'utf8')

test('PIP pan physics uses the main canvas camera options', () => {
  assert.match(
    helper,
    /const panSpeed = options\.cameraOptions\?\.panSpeed \?\? 1/,
    'PIP pan must read the same panSpeed option as the main canvas',
  )
  assert.match(
    helper,
    /x: camera\.x - \(deltaX \* panSpeed\) \/ z/,
    'PIP pan must apply the same speed-scaled camera delta on x',
  )
  assert.match(
    helper,
    /y: camera\.y - \(deltaY \* panSpeed\) \/ z/,
    'PIP pan must apply the same speed-scaled camera delta on y',
  )
})

test('PIP zoom physics uses the main canvas zoom curve and limits', () => {
  assert.match(
    helper,
    /const zoomSpeed = options\.cameraOptions\?\.zoomSpeed \?\? 1/,
    'PIP zoom must read the same zoomSpeed option as the main canvas',
  )
  assert.match(
    helper,
    /const minZoom = zoomSteps\?\.\[0\] \?\? 0\.05[\s\S]*const maxZoom = zoomSteps\?\.\[zoomSteps\.length - 1\] \?\? 8/,
    'PIP zoom must use the same zoomSteps limits as the main canvas',
  )
  assert.match(
    helper,
    /z - \(cappedDelta \/ 100\) \* zoomSpeed \* z/,
    'PIP wheel zoom must use the main canvas linear wheel zoom formula',
  )
})

test('read-only PIPs use one camera gesture path for mouse touch and stylus', () => {
  assert.match(
    panel,
    /const readOnlyCameraInteraction = readOnly && \(interactionMode === 'preview' \|\| interactionMode === 'pinned'\)/,
    'pinned PIPs must not be left behind the read-only capture overlay',
  )
  assert.match(
    panel,
    /if \(e\.pointerType === 'mouse'\) return e\.button === 0[\s\S]*return e\.pointerType === 'touch' \|\| e\.pointerType === 'pen'/,
    'PIP pointer drags must accept primary mouse, touch, and stylus gestures through the same handler',
  )
  assert.match(
    panel,
    /canvasClipPanCamera\(base, -dx, -dy, bounds, panelWidth, canvasHeight, \{[\s\S]*cameraOptions/,
    'PIP pointer pan must go through the shared camera helper',
  )
  assert.match(
    panel,
    /canvasClipWheelCamera\(base, e\.deltaX, e\.deltaY, bounds, panelWidth, canvasHeight, \{[\s\S]*cameraOptions/,
    'PIP wheel pan and zoom must go through the shared camera helper',
  )
})
