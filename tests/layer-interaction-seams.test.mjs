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

/** Source with comments removed, so an assertion cannot match its own prose. */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

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

test('the frame cannot be omitted: every entry point takes one', () => {
  // The advocate's finding on the previous head: `frame` was optional on
  // `dropPillOnTarget` and silently defaulted a projected-panel drop to the main
  // canvas — the same defect as a `LayerFrameConversion` defaulting to the
  // identity. A default that is right for one kind of caller and silently wrong
  // for another, with nothing at the call site saying which, is not a default.
  //
  // These are signature assertions rather than behavioural ones because the
  // property is enforced by the type system: the check that it holds is
  // `tsc -b`, and this is the check that nobody quietly makes it optional again.
  const pill = read('src/shapes/FleetPillShape.tsx')
  assert.match(
    pill,
    /pagePoint: \{ x: number; y: number \},[\s\S]{0,900}?\n  frame: FleetInteractionFrame,/,
    'dropPillOnTarget takes a required frame, before the optionals',
  )
  assert.doesNotMatch(pill, /frame\?: FleetInteractionFrame/, 'and it is not optional anywhere here')

  const utils = read('src/shapes/fleet-utils.ts')
  assert.match(
    utils,
    /options: \{ select\?: boolean; frame: FleetInteractionFrame \}/,
    'placeFleetShapeAtScreenPoint requires a frame, in a required options object',
  )
  // The heuristic it used to apply to itself. It still exists — as a named
  // function a caller invokes on purpose — but not as this callee's fallback.
  const placeStart = utils.indexOf('export async function placeFleetShapeAtScreenPoint')
  const placeBody = utils.slice(placeStart, utils.indexOf('\nexport ', placeStart + 1))
  assert.notEqual(placeBody.length, 0, 'the function is still where this test looks for it')
  // Comments stripped first: this function's doc comment NAMES the heuristic it
  // used to apply, so a bare search cannot tell a call from an explanation of
  // why there is no longer a call. It matched the prose on the first run.
  assert.doesNotMatch(
    stripComments(placeBody),
    /getHudEditor\(\)/,
    'and it no longer picks its own viewport from whether the HUD is open',
  )
})

test('the round trip projects and un-projects through one frame', () => {
  // `pagePointToClient` here and `clientPointToPage` inside
  // placeFleetShapeAtScreenPoint are two halves of one round trip. They were
  // paired by both applying the same `getHudEditor()` heuristic — two copies of
  // a rule, correct only while they stayed in step. Both now read the frame.
  const pill = read('src/shapes/FleetPillShape.tsx')
  for (const call of pill.match(/pagePointToClient\([^)]*\)/g) ?? []) {
    assert.match(call, /frame\.viewportId/, `${call} projects with the gesture's own frame`)
  }
  assert.doesNotMatch(
    stripComments(pill),
    /getHudEditor\(\) \? \(FLEET_HUD_VIEWPORT_ID as TLViewportId\) : undefined/,
    'the inline heuristic is gone from the drop path',
  )
})

test('the nudge guides project through a stated frame, and cite nothing stale', () => {
  // The last live copy of the inline heuristic, in the nudge path §A scopes.
  // Its comment cited `fleetShapeAtScreenPoint in fleet-utils` as doing the
  // same thing — wrong twice over: the function is `placeFleetShapeAtScreenPoint`,
  // and the commit before this one is what stopped it doing that. A citation
  // that names a mechanism is exactly the kind that rots when the mechanism
  // moves, so this checks the claim as well as the code.
  const guides = read('src/overlays/FleetNudgeGuides.tsx')
  assert.match(stripComments(guides), /frameFromHudPresence\(/, 'the frame is stated, not assembled inline')
  assert.doesNotMatch(
    stripComments(guides),
    /getHudEditor\(\) \? \(FLEET_HUD_VIEWPORT_ID as TLViewportId\) : undefined/,
    'the inline viewport heuristic is gone',
  )
  assert.doesNotMatch(guides, /fleetShapeAtScreenPoint/, 'the stale citation is gone, not merely renamed')

  // And the claim the replacement makes: `placeFleetShapeAtScreenPoint` no
  // longer decides its own viewport, so nothing may point at it as the example.
  const utils = read('src/shapes/fleet-utils.ts')
  const start = utils.indexOf('export async function placeFleetShapeAtScreenPoint')
  assert.doesNotMatch(
    stripComments(utils.slice(start, utils.indexOf('\nexport ', start + 1))),
    /getHudEditor\(\)/,
  )
})
