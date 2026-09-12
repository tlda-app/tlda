import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createWMCore } from '../packages/tldraw-wm/src/wm-core.ts'
import {
  copyShapesToLayer,
  layerFrameConversion,
  moveShapesToLayer,
  sameFrame,
  shapeForDestination,
} from '../src/classroom/moveBetweenLayers.ts'
import { resolveContextLayer } from '../src/wm/layer-context.ts'

// Skip, 2026-08-13 03:42:21 EDT, on what the layer model is FOR:
//
//   "fix all the fucking seams where layers were just fake and shit could drift
//   because it wasn't on the fucking layer it was in. Right? Like, shit can't
//   like, we can't have coordinate frame bugs if things are in the right
//   fucking coordinate frames. Like, we can have problems with one layer moving
//   relative to the next, Wrong. But, like, shit in a layer stays in the
//   fucking like, that's crucial."
//
// Every layer relationship in the app today is the identity, which is exactly
// why these tests use a NON-IDENTITY one. Against identity, code that converts
// through the relative transform and code that assumes shared page coordinates
// produce the same answer — so a test on the real configuration cannot tell
// them apart, and would have passed against the version this replaces.

function offsetLayers(dx, dy) {
  const wm = createWMCore()
  wm.defineLayer('source', { parent: wm.rootLayerId })
  wm.defineLayer('destination', { parent: wm.rootLayerId, transform: { x: dx, y: dy } })
  return wm
}

function room({ shapes = [], pageId = 'page:dest' } = {}) {
  const byId = new Map(shapes.map(s => [s.id, s]))
  return {
    byId,
    getShape: id => byId.get(id),
    createShapes: incoming => { for (const s of incoming) byId.set(s.id, s) },
    deleteShapes: ids => { for (const id of ids) byId.delete(id) },
    getCurrentPageId: () => pageId,
  }
}

const mark = (id, over) => ({ id, type: 'draw', x: 100, y: 200, parentId: 'page:source', index: 'a1', props: {}, ...over })

test('a move converts position through the relative transform', () => {
  const wm = offsetLayers(30, -12)
  const convert = layerFrameConversion(wm, 'source', 'destination')

  const out = shapeForDestination(mark('shape:one'), 'page:dest', convert)

  // The counterfactual: carrying x/y across unchanged would leave 100,200 here.
  // That is what the code did before, and against a same-origin layer pair it
  // is indistinguishable from this.
  assert.notDeepEqual({ x: out.x, y: out.y }, { x: 100, y: 200 }, 'position was converted, not carried')
  assert.deepEqual({ x: out.x, y: out.y }, wm.translate({ x: 100, y: 200 }, 'source', 'destination'))
})

test('a shape nested in another moved shape keeps its offset', () => {
  const wm = offsetLayers(30, -12)
  const convert = layerFrameConversion(wm, 'source', 'destination')

  // Its x/y are relative to its parent, which is moving with it. Converting
  // those would apply the layer offset a second time, on top of the parent's.
  const nested = shapeForDestination(mark('shape:two', { parentId: 'shape:one' }), 'page:dest', convert)

  assert.deepEqual({ x: nested.x, y: nested.y }, { x: 100, y: 200 })
  assert.equal(nested.parentId, 'shape:one')
})

test('an identity relationship converts to the same numbers, through the model', () => {
  const wm = offsetLayers(0, 0)
  const convert = layerFrameConversion(wm, 'source', 'destination')

  const out = shapeForDestination(mark('shape:one'), 'page:dest', convert)

  // This is the case the app is actually in, and the point is that it arrives
  // here by asking rather than by assuming: same answer, different derivation.
  assert.deepEqual({ x: out.x, y: out.y }, { x: 100, y: 200 })
})

test('move and copy both convert; neither writes source-frame coordinates', () => {
  const wm = offsetLayers(45, 7)
  const convert = layerFrameConversion(wm, 'source', 'destination')
  const expected = wm.translate({ x: 100, y: 200 }, 'source', 'destination')

  const moveSource = room({ shapes: [mark('shape:one')] })
  const moveDestination = room()
  moveShapesToLayer(moveSource, moveDestination, ['shape:one'], convert)
  const moved = moveDestination.getShape('shape:one')
  assert.deepEqual({ x: moved.x, y: moved.y }, expected)

  const copySource = room({ shapes: [mark('shape:one')] })
  const copyDestination = room()
  copyShapesToLayer(copySource, copyDestination, ['shape:one'], () => 'shape:copy', convert)
  const copied = copyDestination.getShape('shape:copy')
  assert.deepEqual({ x: copied.x, y: copied.y }, expected)

  // The original did not move. A copy that converts the source in place would
  // be a silent corruption of the layer it was copied FROM.
  assert.deepEqual(
    { x: copySource.getShape('shape:one').x, y: copySource.getShape('shape:one').y },
    { x: 100, y: 200 },
  )
})

test('sameFrame is the identity, and says so by name', () => {
  assert.deepEqual(sameFrame({ x: 3, y: 4 }), { x: 3, y: 4 })
})

// --- The membership seam: two shapes at the same page coordinates, in two
// --- layers, are not near each other and must not be compared.

test('two layers can hold the same page coordinates and mean different places', () => {
  const wm = offsetLayers(500, 0)

  // Identical numbers in both frames. This is the whole reason a page-bounds
  // comparison cannot decide whether two shapes are adjacent: it sees 100 and
  // 100 and concludes they are touching.
  const here = { x: 100, y: 200 }
  const there = wm.translate(here, 'source', 'destination')
  assert.notDeepEqual(there, here)
})

test('sameLayer separates two shapes a page-coordinate test cannot', () => {
  const wm = createWMCore()
  wm.defineLayer('hud', { parent: wm.rootLayerId })
  wm.defineLayer('document-page', { parent: wm.rootLayerId })
  wm.setShapeLayerResolver(shape => shape.layerId ?? null)

  const onHud = { id: 'shape:a', layerId: 'hud', x: 10, y: 10 }
  const onDocument = { id: 'shape:b', layerId: 'document-page', x: 10, y: 10 }
  const alsoHud = { id: 'shape:c', layerId: 'hud', x: 10, y: 10 }

  // All three sit at identical coordinates; only membership distinguishes them.
  assert.equal(wm.sameLayer(onHud, onDocument), false, 'a nudge must not cross this')
  assert.equal(wm.sameLayer(onHud, alsoHud), true, 'and must still work within a layer')
})

test('the nudge collector asks membership, not ownership', () => {
  // A source assertion, and it is the weaker kind of evidence, so: it is here
  // because `fleet-utils.ts` cannot be imported outside a browser — it pulls in
  // tldraw and the fleet data module and hangs. The behaviour above is exercised
  // against `wm.sameLayer` directly; this is the check that the call site still
  // calls it, which is the thing that would silently regress. It goes red if the
  // filter is dropped — verified by removing it.
  const source = readFileSync(new URL('../src/shapes/fleet-utils.ts', import.meta.url), 'utf8')
  const collector = source.slice(
    source.indexOf('function collectFleetPanelNudgeCandidates'),
    source.indexOf('function closestFleetPanelNudge'),
  )
  assert.notEqual(collector.length, 0, 'the collector is still where this test looks for it')
  assert.match(collector, /wm\.sameLayer\(shape, current\)/, 'candidates are filtered by layer membership')
  assert.match(collector, /isMyFleetShape\(shape\)/, 'and still by ownership; the layer filter is added, not swapped in')
})

// --- The context/registry seam.

test('the layer a component is on comes from the registry, never from a guess', () => {
  const registry = new Map([['viewport:hud', { coordinateLayerId: 'wm:viewport-camera:viewport:hud' }]])
  const lookup = id => registry.get(id)

  assert.deepEqual(
    resolveContextLayer(undefined, lookup),
    { kind: 'document', layerId: 'document-page' },
    'no viewport context is the main canvas drawing the document',
  )
  assert.deepEqual(
    resolveContextLayer('viewport:hud', lookup),
    { kind: 'viewport', layerId: 'wm:viewport-camera:viewport:hud', viewportId: 'viewport:hud' },
    'a registered viewport reports the layer it projects into',
  )
})

test('an unregistered viewport is reported as such, not as the document', () => {
  const resolution = resolveContextLayer('viewport:nobody-registered', () => undefined)

  // The counterfactual that matters: returning `document-page` here would be a
  // component being told it is on the document while it renders into a viewport
  // that is somewhere else entirely. That reads as agreement and is the seam.
  assert.equal(resolution.kind, 'unregistered')
  assert.equal(resolution.layerId, null)
})

test('the same resolution is the same object, so a consumer can depend on it', () => {
  const registry = new Map([['viewport:hud', { coordinateLayerId: 'wm:viewport-camera:viewport:hud' }]])
  const lookup = id => registry.get(id)

  // Interning is not a performance detail here. Without it, every render hands
  // the fleet panels a new frame object, their gesture handlers are rebuilt,
  // and the chat's document-level listeners are torn down and re-added on each
  // pass. The alternative — a memo whose deps name the fields while its body
  // rebuilds the object — would be a second copy of the resolution logic.
  assert.equal(resolveContextLayer(undefined, lookup), resolveContextLayer(undefined, lookup))
  assert.equal(resolveContextLayer('viewport:hud', lookup), resolveContextLayer('viewport:hud', lookup))
  assert.notEqual(resolveContextLayer('viewport:hud', lookup), resolveContextLayer(undefined, lookup))

  // And it tracks the answer, not the question: the same viewport resolving
  // differently must not be served the old object.
  registry.set('viewport:hud', { coordinateLayerId: 'wm:viewport-camera:other' })
  assert.notEqual(
    resolveContextLayer('viewport:hud', lookup).layerId,
    'wm:viewport-camera:viewport:hud',
  )
})
