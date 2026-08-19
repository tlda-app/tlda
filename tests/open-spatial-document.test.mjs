import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
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
// passing plan.dy would shift the anchor by an amount the camera did not move.
test('the HUD wrap is dispatched with the camera delta, not the plan delta', () => {
  const source = readFileSync(new URL('../src/spatialDocumentWorld.ts', import.meta.url), 'utf8')
  const open = source.slice(source.indexOf('export function openSpatialDocument'))
  assert.match(open, /dispatchFleetHudWrap\(\{ dx: plan\.dx, dy: camera\.y - nextY \}\)/)
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
