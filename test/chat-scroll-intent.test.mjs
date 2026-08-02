import assert from 'node:assert/strict'
import test from 'node:test'

import { decideFollowTransition, FOLLOW_BOTTOM_EPS } from '../src/shapes/chatScrollIntent.mjs'

// The reader is scrolled up, reading history. `scrolledUp: true` is the only
// state that consults the resume path at all.
const READING = { scrolledUp: true, hardLocked: false, programmatic: false }
const FOLLOWING = { scrolledUp: false, hardLocked: false, programmatic: false }

const CLIENT = 400

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
    { scrolledUp: false, hardLocked: false, programmatic: true },
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
