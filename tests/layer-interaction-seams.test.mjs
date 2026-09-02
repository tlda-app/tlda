import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getEditorWMCore, registerViewportLayer } from '../src/wm/editor-wm.ts'
import { fleetInteractionFrame, fleetShapesUnderPointer } from '../src/wm/fleet-interaction-frame.ts'

// The interaction half of §A. `tests/layer-frames.test.mjs` covers the frame
// model — that a move converts, that membership separates two shapes at equal
// page coordinates. This covers the thing that USES it: a drop, deciding which
// shape it landed on.
//
// The seam is that a hit test comparing one page point against every
// candidate's page bounds is asking whether two numbers overlap. When the
// candidates are in different layers, those numbers measure different frames,
// and the comparison succeeds without meaning anything. Every test here builds
// a NON-IDENTITY layer relationship, because against the identity the correct
// implementation and the broken one agree.

/** The page-bounds comparison these call sites used to do, kept as the control. */
function naiveHitTest(point, shapes, boundsOf) {
  return shapes.filter(shape => {
    const b = boundsOf(shape.id)
    return !!b && point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h
  })
}

/**
 * An editor stub: a shape table, page bounds off the records, and a WM whose
 * layers we control. `getEditorWMCore` keys on the editor object, so a fresh
 * object per test gets a fresh core.
 */
function scene({ shapes, hudOffsetX }) {
  const byId = new Map(shapes.map(s => [s.id, s]))
  const editor = {
    getShape: id => byId.get(id),
    getCurrentPageShapes: () => [...byId.values()],
    getShapePageBounds: id => {
      const s = byId.get(id)
      return s ? { x: s.x, y: s.y, w: s.w, h: s.h } : undefined
    },
  }
  const wm = getEditorWMCore(editor)
  wm.defineOrUpdateLayer('document-page', { parent: wm.rootLayerId })
  // The HUD projects with its own camera: the same page coordinates land
  // somewhere else on screen. That offset is the whole point.
  wm.defineOrUpdateLayer('wm:viewport-camera:viewport:hud', {
    parent: wm.rootLayerId,
    transform: { x: hudOffsetX, y: 0 },
  })
  wm.setShapeLayerResolver(shape => shape?.layerId ?? 'document-page')
  registerViewportLayer(editor, {
    viewportId: 'viewport:hud',
    wm,
    frameLayerId: 'wm:viewport-camera:viewport:hud',
    coordinateLayerId: 'wm:viewport-camera:viewport:hud',
  })
  return { editor, wm, boundsOf: id => editor.getShapePageBounds(id) }
}

const box = (id, layerId, x, y) => ({ id, layerId, x, y, w: 100, h: 40, type: 'fleet-chat' })

test('a drop in the HUD does not land on a document shape that shares its numbers', () => {
  // Both boxes are at page (0,0). The HUD layer is offset by 300, so a HUD-frame
  // drop at (50,20) is at (-250,20) in the document frame — nowhere near the
  // document box.
  const { editor, boundsOf } = scene({
    hudOffsetX: 300,
    shapes: [box('shape:hud', 'wm:viewport-camera:viewport:hud', 0, 0), box('shape:doc', 'document-page', 0, 0)],
  })
  const frame = fleetInteractionFrame(editor, 'viewport:hud')
  const point = { x: 50, y: 20 }
  const candidates = editor.getCurrentPageShapes()

  const control = naiveHitTest(point, candidates, boundsOf)
  assert.deepEqual(
    control.map(s => s.id).sort(),
    ['shape:doc', 'shape:hud'],
    'the page-bounds comparison hits BOTH — this is the seam, and it is silent',
  )

  const hits = fleetShapesUnderPointer(editor, frame, point, candidates).map(h => h.shape.id)
  assert.deepEqual(hits, ['shape:hud'], 'the drop lands only on the shape in its own layer')
})

test('a drop still finds a shape in another layer when that layer really is under it', () => {
  // The complement, so the fix is a CONVERSION and not a same-layer filter
  // wearing one. The document box sits at 300, which is where the HUD frame's
  // origin maps to — so a HUD drop at (0,0) genuinely is over it.
  const { editor } = scene({
    hudOffsetX: 300,
    shapes: [box('shape:doc', 'document-page', 300, 0)],
  })
  const frame = fleetInteractionFrame(editor, 'viewport:hud')

  const hits = fleetShapesUnderPointer(editor, frame, { x: 10, y: 10 }, editor.getCurrentPageShapes())
  assert.deepEqual(hits.map(h => h.shape.id), ['shape:doc'])
  assert.deepEqual(
    hits[0].point,
    { x: 310, y: 10 },
    'the probe point is reported in the layer the shape lives in, not the drop frame',
  )
})

test('a gesture in an unregistered viewport hits nothing rather than guessing', () => {
  const { editor } = scene({
    hudOffsetX: 300,
    shapes: [box('shape:doc', 'document-page', 0, 0)],
  })
  const frame = fleetInteractionFrame(editor, 'viewport:never-registered')

  assert.equal(frame.layerId, null)
  assert.equal(frame.resolution.kind, 'unregistered')
  // The counterfactual: falling back to the document layer here would make the
  // drop land on whatever the numbers happened to match, which reads exactly
  // like a correct hit. Refusing is the only answer that is not a guess.
  assert.deepEqual(fleetShapesUnderPointer(editor, frame, { x: 10, y: 10 }, editor.getCurrentPageShapes()), [])
})

test('no viewport is the main canvas, and it hit-tests the document normally', () => {
  const { editor } = scene({
    hudOffsetX: 300,
    shapes: [box('shape:doc', 'document-page', 0, 0)],
  })
  const frame = fleetInteractionFrame(editor, undefined)

  assert.equal(frame.layerId, 'document-page')
  assert.deepEqual(
    fleetShapesUnderPointer(editor, frame, { x: 10, y: 10 }, editor.getCurrentPageShapes()).map(h => h.shape.id),
    ['shape:doc'],
  )
})

test('the frame carries the registry’s answer, not the viewport id it was asked about', () => {
  const { editor } = scene({ hudOffsetX: 300, shapes: [] })

  const registered = fleetInteractionFrame(editor, 'viewport:hud')
  assert.equal(registered.resolution.kind, 'viewport')
  assert.equal(registered.layerId, 'wm:viewport-camera:viewport:hud')

  // Same shape of input, different registry answer. A frame built from the
  // viewport id alone could not tell these apart, which is what "the React
  // context and the window manager's registry have to agree" rules out.
  const unknown = fleetInteractionFrame(editor, 'viewport:other')
  assert.equal(unknown.resolution.kind, 'unregistered')
  assert.equal(unknown.layerId, null)
})

// --- The wiring itself.
//
// An independent review of the first attempt found the model sound and the
// seams still open: `useCurrentLayer` had zero consumers outside its own
// definition. A layer derivation nothing calls is an instrument, not a fix —
// the exact thing this branch's own predecessor was criticised for ("The WM can
// now say which layer a shape is in; almost nothing yet asks it"). These
// assertions are here because that regression is invisible to every behavioural
// test above: they would all still pass with the app calling none of it.

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the fleet panels get their interaction frame from the single derivation', () => {
  for (const path of [
    'src/shapes/FleetSearchShape.tsx',
    'src/shapes/FleetAgentsShape.tsx',
    'src/shapes/FleetChatShape.tsx',
  ]) {
    const source = read(path)
    assert.match(source, /useFleetInteractionFrame\(\)/, `${path} resolves its frame through the hook`)
    // Building it from a bare viewport id is the thing that made four
    // independent answers to "which layer am I on", none of which asked the WM.
    assert.doesNotMatch(source, /fleetInteractionFrame\(viewportId\)/, `${path} does not rebuild it from a raw viewport id`)
  }
})

test('the hook is the one thing that reads the layer derivation', () => {
  assert.match(read('src/wm/useFleetInteractionFrame.ts'), /useCurrentLayer\(\)/)
})

test('the drop path hit-tests through the WM, not against page bounds', () => {
  const source = read('src/shapes/FleetPillShape.tsx')
  const drop = source.slice(source.indexOf('export async function dropPillOnTarget'))
  assert.match(drop, /fleetShapesUnderPointer\(/, 'the drop asks the WM which shapes are under the point')
  // The shape of the comparison it replaced. If this returns, the seam is back.
  assert.doesNotMatch(
    drop.slice(0, drop.indexOf('const overFleet')),
    /targetPagePoint\.x >= /,
    'no raw page-bounds containment test survives in the hit path',
  )
})
