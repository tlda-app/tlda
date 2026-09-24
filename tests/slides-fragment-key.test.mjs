import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fragmentKeyForReport,
  fragmentKeyForSlide,
  nextSlideAction,
  prevSlideAction,
} from '../src/slidesFragmentState.ts'

// Story-2 deck-advance decoupling: a deck is ONE page shape carrying every
// slide, so every slide reports fragments under the SAME shapeId. The
// navigator used to key fragment state by shapeId alone, so with reveal's
// address pinned on an early slide, Next kept stepping that slide's fragments
// instead of advancing the camera — 32 clicks peaked at 12/31 and ended 1/31.

const SHAPE = 'shape:deck'
const TOTAL = 31

function deckKey(i) {
  return fragmentKeyForSlide(SHAPE, i, 0)
}

test('deck slides sharing one shapeId get distinct fragment keys', () => {
  // The old scheme keyed by shapeId alone and could not tell these apart.
  assert.equal(fragmentKeyForSlide(SHAPE, 0, 0), fragmentKeyForSlide(SHAPE, 0, 0))
  assert.notEqual(deckKey(0), deckKey(1))
  assert.notEqual(deckKey(1), deckKey(12))
})

test('counterfactual: old shapeId-only keying sticks Next on the wrong slide', () => {
  // Reveal pinned on slide 0 with unstepped fragments (0/2); camera on slide 1.
  // Keyed the OLD way the map holds slide 0's state under the shared shapeId,
  // so the slide-1 Next reads 0/2 and steps a fragment instead of advancing.
  const oldStyle = new Map([[SHAPE, { total: 2, current: 0 }]])
  assert.equal(nextSlideAction(oldStyle, SHAPE, 1, TOTAL), 'step-fragment')
})

test('fixed keying advances past another slide\'s pending fragments', () => {
  // Same scenario, keyed the NEW way: slide 1 has no state of its own.
  const fixed = new Map([[deckKey(0), { total: 2, current: 0 }]])
  assert.equal(nextSlideAction(fixed, deckKey(1), 1, TOTAL), 'advance-slide')
})

test('a slide\'s own unstepped fragments still step first', () => {
  const state = new Map([[deckKey(5), { total: 3, current: 1 }]])
  assert.equal(nextSlideAction(state, deckKey(5), 5, TOTAL), 'step-fragment')
  const exhausted = new Map([[deckKey(5), { total: 3, current: 3 }]])
  assert.equal(nextSlideAction(exhausted, deckKey(5), 5, TOTAL), 'advance-slide')
})

test('last slide stays put once its fragments are done', () => {
  const done = new Map([[deckKey(30), { total: 1, current: 1 }]])
  assert.equal(nextSlideAction(done, deckKey(30), 30, TOTAL), 'stay')
  const pending = new Map([[deckKey(30), { total: 1, current: 0 }]])
  assert.equal(nextSlideAction(pending, deckKey(30), 30, TOTAL), 'step-fragment')
})

test('prev steps back only through this slide\'s own fragments', () => {
  const stepped = new Map([[deckKey(4), { total: 2, current: 2 }]])
  assert.equal(prevSlideAction(stepped, deckKey(4), 4), 'step-fragment')
  // Another slide's stepped fragments do not hold this slide back.
  const other = new Map([[deckKey(0), { total: 2, current: 2 }]])
  assert.equal(prevSlideAction(other, deckKey(4), 4), 'retreat-slide')
  assert.equal(prevSlideAction(other, deckKey(0), 0), 'step-fragment')
  assert.equal(prevSlideAction(new Map(), deckKey(0), 0), 'stay')
})

test('documents without addresses keep the plain shapeId key', () => {
  assert.equal(fragmentKeyForSlide('shape:page-3'), 'shape:page-3')
  assert.equal(
    fragmentKeyForReport({ shapeId: 'shape:page-3' }, false),
    'shape:page-3',
  )
})

test('bridge reports route to the addressed slide, not slide 0', () => {
  const report = { shapeId: SHAPE, indexh: 2, indexv: 0, current: 0, total: 2 }
  const key = fragmentKeyForReport(report, true)
  assert.equal(key, deckKey(2))
  assert.notEqual(key, deckKey(0))
})

test('reports without addresses fall back to shapeId', () => {
  assert.equal(fragmentKeyForReport({ shapeId: SHAPE }, true), SHAPE)
})
