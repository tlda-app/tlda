import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  MOVE_LOCK_ON,
  RESIZE_LOCK_AFTER_MOVE,
  RESIZE_LOCK_ON,
  applyShapeResizeAxisLock,
  classifyFleetSoftGesture,
  nearestPhoneLaneDocLeftScreen,
  phoneLaneDragDecision,
} from '../src/overlays/fleet-gesture-policy.ts'

const source = readFileSync(new URL('../src/overlays/useFleetGestures.ts', import.meta.url), 'utf8')
const policySource = readFileSync(new URL('../src/overlays/fleet-gesture-policy.ts', import.meta.url), 'utf8')
const frameSource = readFileSync(new URL('../src/overlays/fleet-gesture-frame.ts', import.meta.url), 'utf8')
const tldrawSource = readFileSync(
  new URL('../node_modules/@tldraw/editor/src/lib/hooks/useGestureEvents.ts', import.meta.url),
  'utf8',
)

function tldrawThreshold(pattern, label) {
  const match = tldrawSource.match(pattern)
  assert.ok(match, `missing TLDraw ${label}`)
  return Number(match[1])
}

function tldrawThresholdAt(pattern, index, label) {
  const matches = [...tldrawSource.matchAll(pattern)]
  assert.ok(matches[index], `missing TLDraw ${label}`)
  return Number(matches[index][1])
}

test('fleet gesture classifier mirrors TLDraw touch pinch thresholds', () => {
  assert.equal(
    RESIZE_LOCK_ON,
    tldrawThreshold(/touchDistance > (\d+)[\s\S]*?pinchState = 'zooming'/, 'not-sure zoom threshold'),
  )
  assert.equal(
    MOVE_LOCK_ON,
    tldrawThreshold(/originDistance > (\d+)[\s\S]*?pinchState = 'panning'/, 'not-sure pan threshold'),
  )
  assert.equal(
    RESIZE_LOCK_AFTER_MOVE,
    tldrawThresholdAt(/touchDistance > (\d+)[\s\S]*?pinchState = 'zooming'/g, 1, 'pan-to-zoom threshold'),
  )
  assert.match(source, /from '\.\/fleet-gesture-policy'/)
  assert.match(policySource, /export function classifyFleetSoftGesture/)
})

test('fleet gesture frame adapter owns viewport and DOM frame helpers', () => {
  assert.match(source, /from '\.\/fleet-gesture-frame'/)
  assert.match(frameSource, /export function getGestureViewportCamera/)
  assert.match(frameSource, /export function getGestureViewportContainer/)
  assert.match(frameSource, /export function screenPointToOverlayPage/)
  assert.match(frameSource, /export function describeElement/)
  assert.match(frameSource, /export function elementChainAt/)
  assert.match(frameSource, /export function cornerControlAtPoint/)
  assert.equal(source.includes('function getViewportCamera'), false)
  assert.equal(source.includes('function getViewportContainer'), false)
  assert.equal(source.includes('function screenPointToOverlayPage'), false)
  assert.equal(source.includes('function describeElement'), false)
  assert.equal(source.includes('function elementChainAt'), false)
})

test('phone lane drag consumes touch events so TLDraw pinch cannot inherit them', () => {
  assert.match(
    source,
    /function finishPhoneLaneGesture[\s\S]*snapPhoneLane\(main, state\.docLeftPage\)/,
    'phone lane finish should snap through the shared lane snap helper',
  )
  assert.match(
    source,
    /state\.kind === 'phone-lane' && ts\.length > 1[\s\S]*consumeTouchEvent\(e\)[\s\S]*finishPhoneLaneGesture\(main, state\)/,
    'adding a second finger during a phone lane gesture must be consumed before TLDraw pinch sees it',
  )
  assert.match(
    source,
    /if \(ts\.length !== 1\) \{[\s\S]*consumeTouchEvent\(e\)[\s\S]*finishPhoneLaneGesture\(main, state\)/,
    'touch-count changes during phone lane move must be consumed and snapped',
  )
  assert.match(
    source,
    /state\.kind === 'phone-lane'[\s\S]*main\.setCamera[\s\S]*\n\s*return/,
    'phone lane drag should keep writing camera directly with fixed z',
  )
  assert.doesNotMatch(
    source,
    /state\.kind === 'phone-lane'[\s\S]*stopTouchEvent\(e\)[\s\S]*main\.setCamera/,
    'phone lane drag must preventDefault, not only stop propagation',
  )
})

test('fleet gesture classifier prefers intentional resize before move, then requires larger resize while moving', () => {
  assert.deepEqual(classifyFleetSoftGesture({ moveActive: false, resizeActive: false, travel: 17, spread: 12 }), { moveActive: true, resizeActive: false })
  assert.deepEqual(classifyFleetSoftGesture({ moveActive: false, resizeActive: false, travel: 12, spread: 25 }), { moveActive: true, resizeActive: true })
  assert.deepEqual(classifyFleetSoftGesture({ moveActive: true, resizeActive: false, travel: 30, spread: 25 }), {
    moveActive: true,
    resizeActive: false,
  })
  assert.deepEqual(classifyFleetSoftGesture({ moveActive: true, resizeActive: false, travel: 30, spread: 65 }), {
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

test('phone lane policy chooses the closest lane and filters accidental vertical drags', () => {
  assert.deepEqual(nearestPhoneLaneDocLeftScreen(15, 400), { lane: 'document', docLeftScreen: 0 })
  assert.deepEqual(nearestPhoneLaneDocLeftScreen(365, 400), { lane: 'chat', docLeftScreen: 400 })
  assert.deepEqual(nearestPhoneLaneDocLeftScreen(780, 400), { lane: 'agents-inbox', docLeftScreen: 800 })

  assert.equal(phoneLaneDragDecision(5, 30), 'abort')
  assert.equal(phoneLaneDragDecision(15, 5), 'pending')
  assert.equal(phoneLaneDragDecision(30, 10), 'dragging')
})
