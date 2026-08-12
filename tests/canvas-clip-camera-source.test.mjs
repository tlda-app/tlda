import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/CanvasClipPanel.tsx', import.meta.url), 'utf8')

function sliceFrom(marker, length) {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing marker: ${marker}`)
  return source.slice(start, start + length)
}

test('external viewport camera sync feeds the same camera to DOM shapes and overlay handles', () => {
  const syncBlock = sliceFrom('const syncViewportCamera = (camera:', 900)
  const cameraBlock = sliceFrom('const camera =', 180)

  assert.match(
    syncBlock,
    /applyViewportCameraToDom\(canvasRef\.current, camera\)/,
    'HUD camera sync must keep the direct DOM fast path from the performance fix',
  )
  assert.match(
    syncBlock,
    /setSyncedCamera\(prev => sameCanvasClipCamera\(prev, camera\) \? prev : camera\)/,
    'the same externally synced camera must be published to React state for CanvasOverlays',
  )
  assert.match(
    cameraBlock,
    /const camera = syncedCamera \?\? interactiveCamera \?\? plannedCamera/,
    'TldrawViewport must receive the externally synced camera before falling back to plannedCamera',
  )
})

test('external sync catch-up clears once the planned camera reaches the same value', () => {
  const resetBlock = sliceFrom('useEffect(() => {\n    setInteractiveCamera(null)', 180)

  assert.match(
    resetBlock,
    /setSyncedCamera\(null\)/,
    'syncedCamera is a catch-up bridge, not a second permanent camera source',
  )
})
