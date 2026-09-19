import test from 'node:test'
import assert from 'node:assert/strict'
import { markingInkFrame } from '../src/classroom/markingInkFrame'

const rect = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height,
})

test('the capture covers the absolute answer but stores points from the pair wrapper', () => {
  const frame = markingInkFrame({
    wrapper: rect(40, 80, 600, 300),
    answer: rect(664, 101, 544, 420),
    iframe: rect(110, 70, 960, 1200),
    container: rect(10, 20, 1200, 900),
    iframeClientWidth: 1200,
    iframeOffsetWidth: 1200,
  })
  assert.ok(frame)
  assert.equal(frame.bounds.left, 142)
  assert.equal(frame.bounds.top, 134)
  assert.ok(Math.abs(frame.bounds.width - 934.4) < 1e-9)
  assert.equal(frame.bounds.height, 352.8)
  assert.equal(frame.camera.z, 0.8)
  assert.equal(Math.abs(frame.camera.x), 0)
  assert.equal(Math.abs(frame.camera.y), 0)
  assert.deepEqual(frame.wrapperTransform, { x: 132, y: 114, scale: 0.8 })
})

test('reflow moves the wrapper frame without changing wrapper-local coordinates', () => {
  const before = markingInkFrame({
    wrapper: rect(40, 80, 600, 300), answer: rect(664, 101, 544, 420),
    iframe: rect(110, 70, 960, 1200), container: rect(10, 20, 1200, 900),
    iframeClientWidth: 1200, iframeOffsetWidth: 1200,
  })!
  const after = markingInkFrame({
    wrapper: rect(40, 230, 600, 300), answer: rect(664, 251, 544, 420),
    iframe: rect(110, 70, 960, 1200), container: rect(10, 20, 1200, 900),
    iframeClientWidth: 1200, iframeOffsetWidth: 1200,
  })!
  assert.equal(after.wrapperTransform.y - before.wrapperTransform.y, 120)
  assert.deepEqual(after.camera, before.camera)
})

// Property (1): the pane is drawable whatever it is mounted in.
//
// The glass used to take its geometry from its parent — the stylesheet's
// `position: absolute; inset: 0` — so it was correct only where it happened to
// be mounted. Moved into `.bottom-panels`, a fixed box with only `bottom` and
// `left` and therefore 0x0, it resolved to 0x0 at (16, 956): a layer with no
// area, over nothing, and every stroke fell through to the book's canvas and
// into the shared chapter room every reader sees.
//
// Expressed where it can be checked without a browser: the frame the pane is
// given owes NOTHING to the container. Only `wrapperTransform` — which places a
// WM view layer, not the pane — reads it. So a container of any size, including
// none, leaves the drawable surface and its origin unchanged.
test('the pane geometry does not come from the container', () => {
  const inputs = {
    wrapper: rect(40, 80, 600, 300), answer: rect(664, 101, 544, 420),
    iframe: rect(110, 70, 960, 1200),
    iframeClientWidth: 1200, iframeOffsetWidth: 1200,
  }
  const inBigContainer = markingInkFrame({ ...inputs, container: rect(10, 20, 1200, 900) })!
  const inZeroContainer = markingInkFrame({ ...inputs, container: rect(16, 956, 0, 0) })!

  // The 0x0 parent is the exact box `.bottom-panels` gave it.
  assert.deepEqual(inZeroContainer.bounds, inBigContainer.bounds)
  assert.deepEqual(inZeroContainer.camera, inBigContainer.camera)
  assert.ok(inZeroContainer.bounds.width > 0 && inZeroContainer.bounds.height > 0,
    'a pane with no area is the defect this exists to prevent')
})

test('a frame is refused rather than guessed when the iframe has not laid out', () => {
  // No pane at all is the right answer here: `MarkingInkOverlay` renders nothing
  // without a frame, so a document mid-layout gets no glass rather than one
  // with an invented size.
  assert.equal(markingInkFrame({
    wrapper: rect(40, 80, 600, 300), answer: rect(664, 101, 544, 420),
    iframe: rect(110, 70, 960, 1200), container: rect(10, 20, 1200, 900),
    iframeClientWidth: 0, iframeOffsetWidth: 1200,
  }), null)
})
