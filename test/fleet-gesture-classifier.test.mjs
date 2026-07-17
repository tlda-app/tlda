import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  MOVE_LOCK_ON,
  RESIZE_LOCK_AFTER_MOVE,
  RESIZE_LOCK_ON,
  applyShapeResizeAxisLock,
  classifySoftGesture,
} from '../src/wm/gesture-policy.ts'

const source = readFileSync(new URL('../src/overlays/useFleetGestures.ts', import.meta.url), 'utf8')
const policySource = readFileSync(new URL('../src/wm/gesture-policy.ts', import.meta.url), 'utf8')
const frameSource = readFileSync(new URL('../src/wm/gesture-frame.ts', import.meta.url), 'utf8')

test('fleet gesture classifier uses the shared soft-axis thresholds', () => {
  assert.equal(MOVE_LOCK_ON, 16)
  assert.equal(RESIZE_LOCK_ON, 24)
  assert.equal(RESIZE_LOCK_AFTER_MOVE, 64)
  assert.match(source, /from '\.\.\/wm'/)
  assert.match(policySource, /export function classifySoftGesture/)
})

test('fleet gesture frame adapter owns viewport and DOM frame helpers', () => {
  assert.match(source, /from '\.\.\/wm'/)
  assert.match(frameSource, /export function getGestureViewportCamera/)
  assert.match(frameSource, /export function getGestureViewportContainer/)
  assert.match(frameSource, /export function screenPointToFramePage/)
  assert.match(frameSource, /export function describeElement/)
  assert.match(frameSource, /export function elementChainAt/)
  assert.match(frameSource, /export function cornerControlAtPoint/)
  assert.equal(source.includes('function getViewportCamera'), false)
  assert.equal(source.includes('function getViewportContainer'), false)
  assert.equal(source.includes('function screenPointToFramePage'), false)
  assert.equal(source.includes('function describeElement'), false)
  assert.equal(source.includes('function elementChainAt'), false)
})

test('fleet gesture classifier prefers intentional resize before move, then requires larger resize while moving', () => {
  assert.deepEqual(classifySoftGesture({ moveActive: false, resizeActive: false, travel: 17, spread: 12 }), { moveActive: true, resizeActive: false })
  assert.deepEqual(classifySoftGesture({ moveActive: false, resizeActive: false, travel: 12, spread: 25 }), { moveActive: true, resizeActive: true })
  assert.deepEqual(classifySoftGesture({ moveActive: true, resizeActive: false, travel: 30, spread: 25 }), {
    moveActive: true,
    resizeActive: false,
  })
  assert.deepEqual(classifySoftGesture({ moveActive: true, resizeActive: false, travel: 30, spread: 65 }), {
    moveActive: true,
    resizeActive: true,
  })
})

test('shape resize axis lock softly damps the non-dominant scale', () => {
  const horizontal = applyShapeResizeAxisLock({ enabled: true, axis: null, accX: 0, accY: 0, spanDx: 80, spanDy: 8, scaleX: 2, scaleY: 1.5 })
  assert.equal(horizontal.axis, 'x')
  assert.equal(horizontal.scaleX, 2)
  assert.equal(horizontal.scaleY, 1.06)

  const vertical = applyShapeResizeAxisLock({ enabled: true, axis: null, accX: 0, accY: 0, spanDx: 5, spanDy: 60, scaleX: 1.4, scaleY: 2 })
  assert.equal(vertical.axis, 'y')
  assert.equal(vertical.scaleX, 1.048)
  assert.equal(vertical.scaleY, 2)
})

test('shape resize axis lock is breakable and disabled for tiny spans', () => {
  const flipped = applyShapeResizeAxisLock({
    enabled: true,
    axis: 'x',
    accX: 8,
    accY: 8,
    spanDx: 2,
    spanDy: 40,
    scaleX: 1.8,
    scaleY: 2,
  })
  assert.equal(flipped.axis, 'y')
  assert.equal(flipped.scaleX, 1.096)
  assert.equal(flipped.scaleY, 2)

  assert.deepEqual(
    applyShapeResizeAxisLock({ enabled: false, axis: null, accX: 0, accY: 0, spanDx: 100, spanDy: 0, scaleX: 3, scaleY: 1.2 }),
    { axis: null, accX: 0, accY: 0, scaleX: 3, scaleY: 1.2 },
  )
})
