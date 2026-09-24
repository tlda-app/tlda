import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deckPositionKey,
  resolveInitialSlide,
} from '../src/slidesFragmentState.ts'

// Deck-advance reset: the navigator kept the current slide only in React
// state, so any reload/remount restarted the deck at 1/31 — the mount path
// read ?slide-or-first and nothing recorded where the reader was. The fix
// resumes the tab's last position from sessionStorage unless an explicit
// ?slide link says otherwise.

const TOTAL = 31

test('fresh tab with no param and no stored position opens at slide 1', () => {
  assert.equal(resolveInitialSlide(null, null, TOTAL), 0)
})

test('reload with no param resumes the stored position', () => {
  assert.equal(resolveInitialSlide(null, '12', TOTAL), 12)
})

test('garbage stored position restarts at slide 1, never NaN', () => {
  assert.equal(resolveInitialSlide(null, 'abc', TOTAL), 0)
  assert.equal(resolveInitialSlide(null, null, TOTAL), 0)
  assert.equal(resolveInitialSlide(null, 12, TOTAL), 0)
})

test('stored position clamps to the deck', () => {
  assert.equal(resolveInitialSlide(null, '99', TOTAL), TOTAL - 1)
  assert.equal(resolveInitialSlide(null, '-3', TOTAL), 0)
})

test('explicit ?slide wins over stored position', () => {
  assert.equal(resolveInitialSlide('2', '12', TOTAL), 1)
  assert.equal(resolveInitialSlide('99', '12', TOTAL), TOTAL - 1)
})

test('invalid ?slide keeps the old default of slide 1', () => {
  assert.equal(resolveInitialSlide('abc', '12', TOTAL), 0)
  assert.equal(resolveInitialSlide('', '12', TOTAL), 0)
})

test('position keys are per document', () => {
  assert.notEqual(deckPositionKey('book-a'), deckPositionKey('book-b'))
  assert.equal(deckPositionKey('book-a'), deckPositionKey('book-a'))
})
