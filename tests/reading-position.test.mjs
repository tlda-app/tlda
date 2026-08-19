import assert from 'node:assert/strict'
import test from 'node:test'
import {
  READING_TOP_MARGIN_PX,
  arrivalReadingOffset,
  cameraYForReadingOffset,
  readingOffsetOf,
  topOfDocumentOffset,
} from '../src/readingPosition.ts'

test('an offset read off a camera puts the camera back where it was', () => {
  const bounds = { y: -242384 }
  const camera = { y: 250000, z: 0.4 }
  const offset = readingOffsetOf(camera, bounds)
  assert.equal(cameraYForReadingOffset(offset, bounds), camera.y)
})

test('the same offset in two documents is the same distance below each top edge', () => {
  const long = { y: 0 }
  const short = { y: 900000 }
  const offset = 30000
  assert.equal(
    -cameraYForReadingOffset(offset, long) - long.y,
    -cameraYForReadingOffset(offset, short) - short.y,
  )
})

// Skip's report: a long document carried its y into a short one and left him
// below the end of the text. The camera that does that is the one this replaces.
test('opening an unread document lands at its top, not at the previous y', () => {
  const short = { y: 900000, h: 1200 }
  const carriedOverY = 40000
  const arrival = arrivalReadingOffset(null, 0.5)
  assert.equal(arrival, topOfDocumentOffset(0.5))
  assert.ok(arrival < carriedOverY)
  // The document's top edge is on screen, below the margin.
  const cameraY = cameraYForReadingOffset(arrival, short)
  const viewportTopPageY = -cameraY
  assert.ok(viewportTopPageY <= short.y)
  assert.equal(short.y - viewportTopPageY, READING_TOP_MARGIN_PX / 0.5)
})

test('a saved offset is used when there is one', () => {
  assert.equal(arrivalReadingOffset(30000, 0.5), 30000)
})

test('a saved offset above the document top is clamped to the top', () => {
  assert.equal(arrivalReadingOffset(-999999, 0.5), topOfDocumentOffset(0.5))
})

test('a missing or unusable saved offset falls back to the top', () => {
  for (const saved of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(arrivalReadingOffset(saved, 0.5), topOfDocumentOffset(0.5))
  }
})

test('the top margin scales with zoom so it is 48 screen pixels at any zoom', () => {
  for (const z of [0.2, 0.5, 1, 2]) {
    assert.equal(topOfDocumentOffset(z) * z, -READING_TOP_MARGIN_PX)
  }
})
