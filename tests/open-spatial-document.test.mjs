import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  arrivalCameraX,
  arrivalReadingOffset,
  cameraYForReadingOffset,
  readingOffsetOf,
  readingPositionKey,
  readingPositionOf,
  withReadingPosition,
} from '../src/readingPosition.ts'

// openSpatialDocument itself needs a tldraw Editor and the fleet layout wrap, so
// what is exercised here is the rule it applies, run over the same numbers.
function openDocument({ source, target, camera, positions, projectName = 'p' }) {
  const store = {
    read: node => readingPositionOf(positions, projectName, node.documentRef),
    write: (node, offset) => {
      positions = withReadingPosition(positions, projectName, node.documentRef, offset)
    },
  }
  const sameDocument = source.id === target.id
  if (!sameDocument) store.write(source, readingOffsetOf(camera, source.bounds))
  const arrival = sameDocument
    ? readingOffsetOf(camera, target.bounds)
    : arrivalReadingOffset(store.read(target), camera.z)
  return { cameraY: cameraYForReadingOffset(arrival, target.bounds), positions }
}

const LONG = { id: 'a', documentRef: { id: 'a', path: 'long.md' }, bounds: { y: 0, h: 400000 } }
const SHORT = { id: 'b', documentRef: { id: 'b', path: 'short.md' }, bounds: { y: 900000, h: 1200 } }

// Skip, 2026-08-19 05:16 EDT: "when I ... click on a new project ... it takes me
// to my current y position. In any other project, which usually is way fucking
// below the project has any text."
test('a deep position in a long document does not carry into a short one', () => {
  const camera = { x: 0, y: -300000, z: 0.5 }   // 300000 page units down `long`
  const { cameraY } = openDocument({ source: LONG, target: SHORT, camera, positions: {} })
  const viewportTopPageY = -cameraY
  assert.ok(
    viewportTopPageY < SHORT.bounds.y + SHORT.bounds.h,
    'lands inside the short document, not past the end of its text',
  )
  assert.ok(viewportTopPageY <= SHORT.bounds.y, 'the short document top edge is on screen')
})

test('a document you have read opens where you left it', () => {
  let positions = {}
  // Read `short` down to 400 units, then leave it for `long`.
  positions = openDocument({
    source: SHORT,
    target: LONG,
    camera: { x: 0, y: -(SHORT.bounds.y + 400), z: 0.5 },
    positions,
  }).positions
  assert.equal(positions[readingPositionKey('p', SHORT.documentRef)], 400)
  // Come back to it from anywhere.
  const { cameraY } = openDocument({
    source: LONG,
    target: SHORT,
    camera: { x: 0, y: -123456, z: 0.5 },
    positions,
  })
  assert.equal(-cameraY - SHORT.bounds.y, 400)
})

test('opening the document you are already in does not move the camera', () => {
  const camera = { x: 0, y: -50000, z: 0.5 }
  const { cameraY, positions } = openDocument({
    source: LONG,
    target: LONG,
    camera,
    positions: {},
  })
  assert.equal(cameraY, camera.y)
  assert.deepEqual(positions, {}, 'and stores nothing')
})

test('leaving a document stores where you left it, not where you arrive', () => {
  const { positions } = openDocument({
    source: LONG,
    target: SHORT,
    camera: { x: 0, y: -77000, z: 0.5 },
    positions: {},
  })
  assert.deepEqual(Object.keys(positions), [readingPositionKey('p', LONG.documentRef)])
  assert.equal(positions[readingPositionKey('p', LONG.documentRef)], 77000)
})

test('two projects do not share a position for the same file name', () => {
  const ref = { id: 'x', path: 'notes.md' }
  assert.notEqual(readingPositionKey('alpha', ref), readingPositionKey('beta', ref))
})

// The wrap handler in FleetHUD shifts the HUD anchor by the delta the CAMERA
// moved. openSpatialDocument no longer moves the camera's y by plan.dy, so
// passing plan.dy would shift the anchor by an amount the camera did not move;
// the x likewise when the arrival centers instead of translating.
test('the HUD wrap is dispatched with the camera delta, not the plan delta', () => {
  const source = readFileSync(new URL('../src/spatialDocumentWorld.ts', import.meta.url), 'utf8')
  const open = source.slice(source.indexOf('export function openSpatialDocument'))
  assert.match(open, /dispatchFleetHudWrap\(\{ dx: camera\.x - nextX, dy: camera\.y - nextY \}\)/)
})

// The arrival x is a pure rule over numbers, so unlike the y above it is
// exercised directly rather than through a mirror.
test('opening from empty canvas centers the target instead of inheriting an off-screen position', () => {
  // Tail 4 J3, live numbers: viewport over empty canvas left of the chapter
  // (cam.x 1735, z 0.834, 1200px wide), chapter at x 0, "Slide 21" at 129524.
  // Translating would land cam.x at 1735 − 129524 = −127789, the slide at
  // screen x 3061 — off-canvas.
  const nextX = arrivalCameraX({
    cameraX: 1735,
    planDx: 129524,
    sameDocument: false,
    sourceX: 0,
    targetX: 129524,
    targetW: 1290,
    viewportX: -1735,
    viewportW: 1200 / 0.834,
  })
  const targetCenter = 129524 + 1290 / 2
  assert.equal(nextX, 1200 / 0.834 / 2 - targetCenter)
  assert.ok(Math.abs((targetCenter + nextX) * 0.834 - 600) < 1, 'slide center lands at screen center')
})

test('opening with the source on screen still translates, so the target arrives where the source was', () => {
  const nextX = arrivalCameraX({
    cameraX: 100,
    planDx: 129524,
    sameDocument: false,
    sourceX: 0,
    targetX: 129524,
    targetW: 1290,
    viewportX: -100,
    viewportW: 1200,
  })
  assert.equal(nextX, 100 - 129524)
})

test('a source left edge exactly at the viewport edge still counts as on screen', () => {
  const atRightEdge = arrivalCameraX({
    cameraX: 0,
    planDx: 500,
    sameDocument: false,
    sourceX: 1200,
    targetX: 500,
    targetW: 100,
    viewportX: 0,
    viewportW: 1200,
  })
  assert.equal(atRightEdge, -500)
})

test('opening the document you are already in is the identity in x too, even from empty canvas', () => {
  const nextX = arrivalCameraX({
    cameraX: 1735,
    planDx: 0,
    sameDocument: true,
    sourceX: 0,
    targetX: 0,
    targetW: 800,
    viewportX: -1735,
    viewportW: 1200 / 0.834,
  })
  assert.equal(nextX, 1735)
})

// Going back is not opening. placeStack restores the camera it recorded and the
// annotation viewer goes to bounds it is already showing; neither is a reading
// position, so both stay on activateSpatialDocument.
test('back-navigation and the annotation viewer do not resolve reading positions', () => {
  for (const path of ['../src/placeStack.ts', '../src/overlays/AnnotationViewer.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /activateSpatialDocument/, `${path} still navigates`)
    assert.doesNotMatch(source, /openSpatialDocument/, `${path} does not open`)
  }
})
