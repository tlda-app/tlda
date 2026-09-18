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
