import test from 'node:test'
import assert from 'node:assert/strict'
import { createWMCore } from '../src/wm/wm-core.ts'

// The shape-membership half of the layer model — §2.4 of the design, "shapes
// belong to a layer and move between them". docs/window-manager.md §Errata
// recorded it as implemented with zero callers, which is why nothing in the app
// could answer "which layer is this shape in".
//
// These are core tests: no tldraw, no fleet identity. The host supplies the one
// function that reads its own records; everything below exercises what the core
// does with the answer.

// Two layers over one root with different transforms, so a point that lands
// inside a shape in one layer lands outside the same rectangle in the other.
// That difference is the whole reason membership has to be asked before a hit
// is decided, and a fixture where the layers agree would prove nothing.
function twoLayers() {
  const wm = createWMCore({ rootLayerId: 'screen' })
  wm.defineLayer('document-page', {
    parent: 'screen',
    transform: { x: 0, y: 0, scale: 2 },
  })
  wm.defineLayer('fleet-overlay', {
    parent: 'screen',
    policy: { x: 'pan', y: 'pin', zoom: 'lock' },
    transform: { x: 100, y: 40, scale: 1 },
  })
  return wm
}

// A host resolver, of the shape a real one has: it reads the record it was
// given and names a layer. Anything it does not recognise is not placed.
function byType(wm) {
  wm.setShapeLayerResolver((shape) => {
    if (shape?.type === 'fleet-chat') return 'fleet-overlay'
    if (shape?.type === 'page') return 'document-page'
    return null
  })
  return wm
}

test('a shape reports the layer the host resolver places it in', () => {
  const wm = byType(twoLayers())
  assert.equal(wm.layerIdOfShape({ type: 'fleet-chat' }), 'fleet-overlay')
  assert.equal(wm.layerIdOfShape({ type: 'page' }), 'document-page')
  assert.equal(wm.layerOfShape({ type: 'fleet-chat' }).policy.y, 'pin')
})

test('an unplaced shape is in the root rather than nowhere', () => {
  const wm = byType(twoLayers())
  assert.equal(wm.layerIdOfShape({ type: 'arrow' }), 'screen')
  assert.equal(wm.layerIdOfShape(null), 'screen')
})

test('a layer this core has never defined is not claimed as membership', () => {
  const wm = twoLayers()
  wm.setShapeLayerResolver(() => 'a-layer-from-some-other-core')
  // The WM answers where it can back the answer with a transform. Returning the
  // name anyway would hand a caller a layer id that every later translate call
  // throws on.
  assert.equal(wm.layerIdOfShape({ type: 'fleet-chat' }), 'screen')
})

test('the default resolver reads the layer off the record', () => {
  const wm = twoLayers()
  assert.equal(wm.layerIdOfShape({ layerId: 'document-page' }), 'document-page')
  assert.equal(wm.layerIdOfShape({ id: 'no-layer' }), 'screen')
})

test('sameLayer separates two shapes the app renders side by side', () => {
  const wm = byType(twoLayers())
  const panel = { type: 'fleet-chat' }
  const other = { type: 'fleet-chat' }
  const page = { type: 'page' }
  assert.equal(wm.sameLayer(panel, other), true)
  assert.equal(wm.sameLayer(panel, page), false)
})

test('shapeExtentIn reads an extent in the shape’s own layer', () => {
  const wm = byType(twoLayers())
  // A panel at (10, 10) in fleet-overlay, whose transform offsets by (100, 40).
  const onScreen = wm.shapeExtentIn({ type: 'fleet-chat' }, { x: 10, y: 10, w: 50, h: 20 }, 'screen')
  assert.deepEqual(onScreen, { x: 110, y: 50, w: 50, h: 20 })

  // The same numbers read as a page shape instead land somewhere else entirely,
  // because document-page is at scale 2. Same extent, different membership,
  // different answer — which is the failure a caller that picks its own frame
  // ships silently.
  const asPage = wm.shapeExtentIn({ type: 'page' }, { x: 10, y: 10, w: 50, h: 20 }, 'screen')
  assert.deepEqual(asPage, { x: 20, y: 20, w: 100, h: 40 })
})

test('hitTest decides each candidate in its own layer', () => {
  const wm = byType(twoLayers())
  const panel = { id: 'panel', type: 'fleet-chat', x: 10, y: 10, w: 50, h: 20 }
  const page = { id: 'page', type: 'page', x: 10, y: 10, w: 50, h: 20 }

  // Screen (150, 65) is inside the panel: it is (50, 50 - 25) → (50, 25) in
  // fleet-overlay, within [10,60]×[10,30]. In document-page the same screen
  // point is (75, 32.5), past the page shape's right edge. One probe, two
  // frames, one hit.
  const hits = wm.hitTest({ x: 150, y: 65 }, 'screen', [panel, page], (s) => s)
  assert.deepEqual(hits.map((hit) => hit.shape.id), ['panel'])
  assert.equal(hits[0].layerId, 'fleet-overlay')
  assert.deepEqual({ x: hits[0].point.x, y: hits[0].point.y }, { x: 50, y: 25 })

  // Screen (40, 40) is inside the page shape — (20, 20) in document-page — and
  // outside the panel, which starts at screen x 110.
  const pageHits = wm.hitTest({ x: 40, y: 40 }, 'screen', [panel, page], (s) => s)
  assert.deepEqual(pageHits.map((hit) => hit.shape.id), ['page'])
  assert.equal(pageHits[0].layerId, 'document-page')
})

test('hitTest skips a candidate with no extent instead of hitting at its origin', () => {
  const wm = byType(twoLayers())
  const hits = wm.hitTest({ x: 100, y: 40 }, 'screen', [{ type: 'fleet-chat' }], () => null)
  assert.deepEqual(hits, [])
})

test('moveToLayer restates coordinates without moving the shape on screen', () => {
  const wm = byType(twoLayers())
  const panel = { id: 'panel', type: 'fleet-chat', x: 10, y: 10 }

  const moved = wm.moveToLayer(panel, 'document-page')
  assert.equal(moved.layerId, 'document-page')
  // (10,10) in fleet-overlay is (110,50) on screen, which is (55,25) at scale 2.
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: 55, y: 25 })

  // The screen position is the invariant a reparent must preserve: the shape
  // does not move, its coordinates are restated. Read against the layers
  // themselves — a host resolver decides by type and will not honour the
  // `layerId` this call stamps on the returned record, which is a statement of
  // where the caller intends to put the shape rather than a fact about it.
  const before = wm.translate({ x: panel.x, y: panel.y }, 'fleet-overlay', 'screen')
  const after = wm.translate({ x: moved.x, y: moved.y }, 'document-page', 'screen')
  assert.deepEqual({ x: after.x, y: after.y }, { x: before.x, y: before.y })
})

test('moveToLayer resolves the source layer rather than requiring one on the record', () => {
  const wm = byType(twoLayers())
  // A real tldraw shape carries no layerId. Before membership resolved, this
  // threw on `Layer "undefined" is not defined`, which is why the operation had
  // no callers.
  const moved = wm.moveToLayer({ id: 'panel', type: 'fleet-chat', x: 0, y: 0 }, 'screen')
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: 100, y: 40 })
})

test('a rejected re-parent leaves the layer graph as it was', () => {
  const wm = twoLayers()
  wm.defineLayer('child', { parent: 'fleet-overlay' })
  assert.throws(() => wm.updateLayer('fleet-overlay', { parent: 'child' }), /cycle/)
  // The throw has to mean the change did not happen. Assigning first and
  // validating after left the bad parent written and the next translate walked
  // it forever.
  assert.equal(wm.getLayer('fleet-overlay').parent, 'screen')
  assert.deepEqual(wm.translate({ x: 0, y: 0 }, 'fleet-overlay', 'screen'), { x: 100, y: 40 })
})
