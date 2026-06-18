import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/overlays/useFleetGestures.ts', import.meta.url), 'utf8')
const tldrawSource = readFileSync(
  new URL('../node_modules/@tldraw/editor/src/lib/hooks/useGestureEvents.ts', import.meta.url),
  'utf8',
)

function numberConst(name) {
  const match = source.match(new RegExp(`const ${name} = (\\d+)`))
  assert.ok(match, `missing ${name}`)
  return Number(match[1])
}

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

function classify({ moveActive = false, resizeActive = false, travel, spread }) {
  const moveOn = numberConst('MOVE_LOCK_ON')
  const resizeOn = numberConst('RESIZE_LOCK_ON')
  const resizeAfterMove = numberConst('RESIZE_LOCK_AFTER_MOVE')

  if (!resizeActive) {
    if (!moveActive && spread > resizeOn) {
      resizeActive = true
    } else {
      if (travel > moveOn) moveActive = true
      if (moveActive && spread > resizeAfterMove) resizeActive = true
    }
  }
  if (resizeActive) moveActive = true
  return { moveActive, resizeActive }
}

function resizeAxisConst(name) {
  const match = source.match(new RegExp(`const ${name} = (\\d+(?:\\.\\d+)?)`))
  assert.ok(match, `missing ${name}`)
  return Number(match[1])
}

function resizeAxisLock({ enabled = true, axis = null, accX = 0, accY = 0, spanDx, spanDy, scaleX, scaleY }) {
  if (!enabled) return { axis, accX, accY, scaleX, scaleY }
  const initial = resizeAxisConst('RESIZE_AXIS_LOCK_INITIAL')
  const breakRatio = resizeAxisConst('RESIZE_AXIS_BREAK_RATIO')
  const damp = resizeAxisConst('RESIZE_AXIS_OFFAXIS_DAMP')
  const decay = resizeAxisConst('RESIZE_AXIS_DECAY')

  accX = accX * decay + Math.abs(spanDx)
  accY = accY * decay + Math.abs(spanDy)
  if (accX + accY >= initial) {
    if (axis === null) axis = accY >= accX ? 'y' : 'x'
    else if (axis === 'y' && accX > accY * breakRatio) axis = 'x'
    else if (axis === 'x' && accY > accX * breakRatio) axis = 'y'
  }

  if (axis === 'x') scaleY = 1 + (scaleY - 1) * damp
  else if (axis === 'y') scaleX = 1 + (scaleX - 1) * damp
  return { axis, accX, accY, scaleX, scaleY }
}

test('fleet gesture classifier mirrors TLDraw touch pinch thresholds', () => {
  assert.equal(
    numberConst('RESIZE_LOCK_ON'),
    tldrawThreshold(/touchDistance > (\d+)[\s\S]*?pinchState = 'zooming'/, 'not-sure zoom threshold'),
  )
  assert.equal(
    numberConst('MOVE_LOCK_ON'),
    tldrawThreshold(/originDistance > (\d+)[\s\S]*?pinchState = 'panning'/, 'not-sure pan threshold'),
  )
  assert.equal(
    numberConst('RESIZE_LOCK_AFTER_MOVE'),
    tldrawThresholdAt(/touchDistance > (\d+)[\s\S]*?pinchState = 'zooming'/g, 1, 'pan-to-zoom threshold'),
  )
})

test('fleet gesture classifier prefers intentional resize before move, then requires larger resize while moving', () => {
  assert.deepEqual(classify({ travel: 17, spread: 12 }), { moveActive: true, resizeActive: false })
  assert.deepEqual(classify({ travel: 12, spread: 25 }), { moveActive: true, resizeActive: true })
  assert.deepEqual(classify({ moveActive: true, travel: 30, spread: 25 }), {
    moveActive: true,
    resizeActive: false,
  })
  assert.deepEqual(classify({ moveActive: true, travel: 30, spread: 65 }), {
    moveActive: true,
    resizeActive: true,
  })
})

test('shape resize axis lock softly damps the non-dominant scale', () => {
  const horizontal = resizeAxisLock({ spanDx: 80, spanDy: 8, scaleX: 2, scaleY: 1.5 })
  assert.equal(horizontal.axis, 'x')
  assert.equal(horizontal.scaleX, 2)
  assert.equal(horizontal.scaleY, 1.06)

  const vertical = resizeAxisLock({ spanDx: 5, spanDy: 60, scaleX: 1.4, scaleY: 2 })
  assert.equal(vertical.axis, 'y')
  assert.equal(vertical.scaleX, 1.048)
  assert.equal(vertical.scaleY, 2)
})

test('shape resize axis lock is breakable and disabled for tiny spans', () => {
  const flipped = resizeAxisLock({
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
    resizeAxisLock({ enabled: false, spanDx: 100, spanDy: 0, scaleX: 3, scaleY: 1.2 }),
    { axis: null, accX: 0, accY: 0, scaleX: 3, scaleY: 1.2 },
  )
})
