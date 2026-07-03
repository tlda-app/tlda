import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  MOVE_LOCK_ON,
  RESIZE_LOCK_AFTER_MOVE,
  RESIZE_LOCK_ON,
  applyShapeResizeAxisLock,
  classifySoftGesture,
  nearestLaneDocLeftScreen,
  phoneLaneDragDecision,
} from '../src/wm/gesture-policy.ts'

const source = readFileSync(new URL('../src/overlays/useFleetGestures.ts', import.meta.url), 'utf8')
const phoneHandSource = readFileSync(new URL('../src/tools/PhoneHandTool.ts', import.meta.url), 'utf8')
const phoneArrowSource = readFileSync(new URL('../src/overlays/PhoneLaneArrow.tsx', import.meta.url), 'utf8')
const policySource = readFileSync(new URL('../src/wm/gesture-policy.ts', import.meta.url), 'utf8')
const frameSource = readFileSync(new URL('../src/wm/gesture-frame.ts', import.meta.url), 'utf8')
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

test('phone pane stack max is cached at gesture start, not scanned per move', () => {
  const touchMoveSource = source.slice(source.indexOf('const onTouchMove = (e: TouchEvent) =>'))
  const phoneLaneMoveBlock = touchMoveSource.slice(
    touchMoveSource.indexOf("if (state.kind === 'phone-lane') {"),
    touchMoveSource.indexOf("if (state.kind === 'pan') {"),
  )

  assert.match(source, /const maxPaneIndex = phonePaneStackMaxIndex\(main\)[\s\S]*startLaneIndex = phoneLaneIndexFromCamera\(main, docLeftPage, maxPaneIndex\)/)
  assert.match(source, /state\.kind === 'phone-lane'[\s\S]*phoneLaneExistsFromIndex\(state\.startLaneIndex, state\.maxPaneIndex, dir\)/)
  assert.doesNotMatch(phoneLaneMoveBlock, /phonePaneStackMaxIndex\(main\)/)

  assert.match(phoneHandSource, /this\.maxPaneIndex = phonePaneStackMaxIndex\(this\.editor\)[\s\S]*phoneLaneIndexFromCamera\(this\.editor, getPrimaryDocumentLeft\(this\.editor\) \?\? 0, this\.maxPaneIndex\)/)
  assert.match(phoneHandSource, /phoneLaneExistsFromIndex\(this\.startLaneIndex, this\.maxPaneIndex, dir\)/)
  assert.doesNotMatch(phoneHandSource, /private update\(\)[\s\S]*phonePaneStackMaxIndex\(this\.editor\)/)
})

test('phone lane commit and arrow use stored portrait width, not live viewport width', () => {
  assert.match(source, /let phoneLanePortraitWidthPx = 0/)
  assert.match(source, /export function rememberPhoneLanePortraitWidth\(editor/)
  assert.match(source, /export function phoneLaneCommitPx\(\)/)
  assert.doesNotMatch(source, /phoneLaneCommitPx\(screenW/)
  assert.doesNotMatch(source, /screenW \* PHONE_LANE_COMMIT_FRAC/)

  assert.match(phoneArrowSource, /const arrowWidthPx = s\.arrowWidthPx \|\| phoneLaneCommitPx\(\)/)
  assert.doesNotMatch(phoneArrowSource, /width: '75vw'/)
  assert.doesNotMatch(phoneArrowSource, /maxHeight: '46vh'/)
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

test('phone lane policy chooses the closest lane and filters accidental vertical drags', () => {
  const stops = [
    { lane: 'agents-inbox', docLeftScreen: 800 },
    { lane: 'chat', docLeftScreen: 400 },
    { lane: 'document', docLeftScreen: 0 },
  ]
  assert.deepEqual(nearestLaneDocLeftScreen(15, stops), { lane: 'document', docLeftScreen: 0 })
  assert.deepEqual(nearestLaneDocLeftScreen(365, stops), { lane: 'chat', docLeftScreen: 400 })
  assert.deepEqual(nearestLaneDocLeftScreen(780, stops), { lane: 'agents-inbox', docLeftScreen: 800 })

  assert.equal(phoneLaneDragDecision(5, 30), 'abort')
  assert.equal(phoneLaneDragDecision(15, 5), 'pending')
  assert.equal(phoneLaneDragDecision(30, 10), 'dragging')
})
