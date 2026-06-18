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
