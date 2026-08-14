import assert from 'node:assert/strict'
import test from 'node:test'

import { decideFollowTransition, FOLLOW_BOTTOM_EPS } from '../src/shapes/chatScrollIntent.mjs'
import { anchoredSensorTailTop, anchoredTailTop } from '../src/shapes/chatViewportAnchor.mjs'

// The reader is scrolled up, reading history. `scrolledUp: true` is the only
// state that consults the resume path at all.
const READING = { scrolledUp: true, hardLocked: false, geometryReconciliation: false, userInputActive: true }
const FOLLOWING = { scrolledUp: false, hardLocked: false, geometryReconciliation: false, userInputActive: true }

const CLIENT = 400

test('anchored tail comes from the rendered last row, not stale estimated total', () => {
  assert.equal(anchoredTailTop({
    renderedLastRowTop: 900,
    renderedLastRowHeight: 60,
    viewportHeight: CLIENT,
    fallbackTotal: 1300,
  }), 560)
})

test('anchored tail falls back to estimated total until the last row is rendered', () => {
  assert.equal(anchoredTailTop({
    renderedLastRowTop: Number.NaN,
    renderedLastRowHeight: Number.NaN,
    viewportHeight: CLIENT,
    fallbackTotal: 1300,
  }), 900)
})

test('the native sensor parks at its rigid bottom boundary', () => {
  assert.equal(anchoredSensorTailTop(20_000_008, 756), 19_999_252)
  assert.equal(anchoredSensorTailTop(500, 756), 0)
})

/** A scroll event: where the viewport landed, and where it was on the previous event. */
function sample({ top, height, lastTop, lastHeight = height }) {
  return { top, height, clientHeight: CLIENT, lastTop, lastHeight }
}

test('scrolling back down to the true bottom resumes follow', () => {
  const out = decideFollowTransition(
    sample({ top: 600, height: 1000, lastTop: 400 }),
    READING,
  )
  assert.deepEqual(out, { scrolledUp: false, action: 'follow-on' })
})

test('a message arriving mid-scroll does not strand the reader off-follow', () => {
  // The regression this covers: the reader flicks back down while a new message
  // lands, so the list grew between the previous scroll event and this one. They
  // come to rest at the true bottom and no further scroll event ever fires — so
  // if this event is discarded, follow stays off while they sit at the bottom,
  // and the next message does not bring them down.
  const out = decideFollowTransition(
    sample({ top: 900, height: 1300, lastTop: 400, lastHeight: 1000 }),
    READING,
  )
  assert.deepEqual(out, { scrolledUp: false, action: 'follow-on' })
})

test('a content shrink that clamps scrollTop does not count as returning to the bottom', () => {
  // A shrink clamps scrollTop down to fit the smaller content: the viewport ends
  // at the bottom without the user moving. top < lastTop is what distinguishes
  // it from a real downward move.
  const out = decideFollowTransition(
    sample({ top: 300, height: 700, lastTop: 600, lastHeight: 1000 }),
    READING,
  )
  assert.deepEqual(out, { scrolledUp: true, action: 'none' })
})

test('landing short of the bottom keeps holding position', () => {
  const out = decideFollowTransition(
    sample({ top: 300, height: 1000 + FOLLOW_BOTTOM_EPS * 2, lastTop: 100 }),
    READING,
  )
  assert.deepEqual(out, { scrolledUp: true, action: 'none' })
})

test('scrolling up stops follow so an arriving message cannot yank the reader', () => {
  const out = decideFollowTransition(
    sample({ top: 400, height: 1000, lastTop: 600 }),
    FOLLOWING,
  )
  assert.deepEqual(out, { scrolledUp: true, action: 'follow-off' })
})

test('sub-pixel scroll noise is not a scroll up', () => {
  const out = decideFollowTransition(
    sample({ top: 598, height: 1000, lastTop: 600 }),
    FOLLOWING,
  )
  assert.deepEqual(out, { scrolledUp: false, action: 'none' })
})

test('a scroll up mid-pin is still the user, because pins only ever scroll down', () => {
  const out = decideFollowTransition(
    sample({ top: 400, height: 1000, lastTop: 600 }),
    { scrolledUp: false, hardLocked: false, geometryReconciliation: false, userInputActive: true },
  )
  assert.deepEqual(out, { scrolledUp: true, action: 'follow-off' })
})

test('hard lock ignores scroll intent entirely', () => {
  const out = decideFollowTransition(
    sample({ top: 100, height: 1000, lastTop: 600 }),
    { scrolledUp: false, hardLocked: true, programmatic: false },
  )
  assert.deepEqual(out, { scrolledUp: false, action: 'none' })
})

// The live-session findings. Numbers are real records from client.log.

test('a few pixels of drift at the bottom does not stop follow', () => {
  // 250 recorded follow-offs looked like this: the reader at the tail, an 8px
  // move, content height unchanged. The virtualizer settling, not a person.
  const out = decideFollowTransition(
    { top: 20864, height: 21370, clientHeight: 497, lastTop: 20872, lastHeight: 21370 },
    FOLLOWING,
  )
  assert.deepEqual(out, { scrolledUp: false, action: 'none' })
})

test('a position past the bottom is not a scroll up', () => {
  // gap -187: the browser reconciling an over-scrolled position. Nobody can
  // scroll to a negative gap, so this can only be content, never intent.
  const out = decideFollowTransition(
    { top: 21135, height: 21445, clientHeight: 497, lastTop: 21141, lastHeight: 21445 },
    FOLLOWING,
  )
  assert.deepEqual(out, { scrolledUp: false, action: 'none' })
})

test('a real scroll up away from the bottom still stops follow', () => {
  // 129 of the 155 genuine scroll-ups: a move over 20px that leaves the tail.
  // This is what the whole mechanism exists for and it must keep working.
  const out = decideFollowTransition(
    { top: 20500, height: 21370, clientHeight: 497, lastTop: 20872, lastHeight: 21370 },
    FOLLOWING,
  )
  assert.deepEqual(out, { scrolledUp: true, action: 'follow-off' })
})

test('Virtuoso re-anchor after reaching bottom cannot disable follow', () => {
  // Exact production sequence from Skip's panel at 2026-08-07T16:29:54Z:
  // the reader had just reached true bottom, then Virtuoso shifted scrollTop
  // upward 661px without a wheel/touch/pointer gesture.
  const out = decideFollowTransition(
    {
      top: 37455,
      height: 38678,
      clientHeight: 560,
      lastTop: 38116.81640625,
      lastHeight: 38677,
    },
    { scrolledUp: false, hardLocked: false, geometryReconciliation: false, userInputActive: false },
  )
  assert.deepEqual(out, { scrolledUp: false, action: 'none' })
})
