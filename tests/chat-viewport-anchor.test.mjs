import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isReaderInputInFlight,
  nextEarlierChatHistoryWindow,
  preserveChatViewportAcrossArrival,
  shouldPrefetchEarlierChatHistory,
  shouldPreserveChatViewport,
} from '../src/shapes/chatViewportAnchor.mjs'

test('earlier history prefetch starts one rendered viewport before the top', () => {
  assert.equal(shouldPrefetchEarlierChatHistory({ top: 601, viewportHeight: 600 }), false)
  assert.equal(shouldPrefetchEarlierChatHistory({ top: 600, viewportHeight: 600 }), true)
  assert.equal(shouldPrefetchEarlierChatHistory({ top: 0, viewportHeight: 600 }), true)
})

test('earlier history page guesses double up to the server paging limit', () => {
  assert.equal(nextEarlierChatHistoryWindow(100, 100), 200)
  assert.equal(nextEarlierChatHistoryWindow(200, 100), 400)
  assert.equal(nextEarlierChatHistoryWindow(400, 100), 500)
})

function arrivalCase({ currentAnchorTop, scrollVelocity = 0, input, inFlight = {} }) {
  const before = {
    scrollTop: 1200,
    scrollHeight: 3000,
    anchorTop: 96,
    scrollVelocity,
    input,
  }
  const after = {
    ...before,
    scrollHeight: 3120,
    currentAnchorTop,
  }
  const result = preserveChatViewportAcrossArrival({
    scrollTop: after.scrollTop,
    scrollHeight: after.scrollHeight,
    anchorTop: before.anchorTop,
    currentAnchorTop: after.currentAnchorTop,
    scrolledUp: true,
    hardLocked: false,
    hasAnchor: true,
    scrollVelocity: before.scrollVelocity,
    ...inFlight,
  })
  return { before, after, result }
}

test('arrival while static off-bottom preserves viewport offset; only scrollHeight grows', () => {
  const { before, after, result } = arrivalCase({ currentAnchorTop: 126, input: 'static' })

  assert.equal(after.scrollHeight - before.scrollHeight, 120)
  assert.equal(result.delta, 30)
  assert.equal(result.scrollTop, 1230)
  assert.equal(result.scrollVelocity, before.scrollVelocity)
  assert.equal(result.scrollHeight, after.scrollHeight)
})

// The two cases below previously named an `input` in the fixture, never passed
// it to the function, and asserted the correction was written anyway — which is
// the behaviour that put a jitter under Skip's finger. They were green from
// `7430200ad` until this commit, across the whole regression.
test('arrival during active wheel input defers the write and leaves the position alone', () => {
  const { before, after, result } = arrivalCase({
    currentAnchorTop: 64,
    scrollVelocity: -720,
    input: 'active-wheel',
    inFlight: { explicitScrollInput: true },
  })

  assert.equal(after.scrollHeight - before.scrollHeight, 120)
  assert.equal(result.deferred, true)
  assert.equal(result.preserved, false)
  assert.equal(result.scrollTop, before.scrollTop)
  assert.equal(result.scrollVelocity, -720)
  assert.equal(result.scrollHeight, after.scrollHeight)
})

test('arrival during momentum scroll defers the write and does not fight the glide', () => {
  const { before, after, result } = arrivalCase({
    currentAnchorTop: 141,
    scrollVelocity: 380,
    input: 'momentum-touch',
    inFlight: { touchScrollActive: true },
  })

  assert.equal(after.scrollHeight - before.scrollHeight, 120)
  assert.equal(result.deferred, true)
  assert.equal(result.preserved, false)
  assert.equal(result.scrollTop, before.scrollTop)
  assert.equal(result.scrollVelocity, 380)
  assert.equal(result.scrollHeight, after.scrollHeight)
})

test('the same arrival is corrected once the gesture has settled', () => {
  const { before, result } = arrivalCase({
    currentAnchorTop: 141,
    scrollVelocity: 0,
    input: 'settled-after-momentum',
    inFlight: { touchScrollActive: false },
  })

  assert.equal(result.deferred, false)
  assert.equal(result.preserved, true)
  assert.equal(result.delta, 45)
  assert.equal(result.scrollTop, before.scrollTop + 45)
})

test('a held pointer inside the panel also defers the write', () => {
  const { before, result } = arrivalCase({
    currentAnchorTop: 141,
    input: 'pointer-held',
    inFlight: { pointerHeldInPanel: true },
  })

  assert.equal(result.deferred, true)
  assert.equal(result.scrollTop, before.scrollTop)
})

test('input in flight covers the glide, not only a pointer that is down', () => {
  // An iOS momentum glide runs with the finger already lifted. Keying the guard
  // on pointers-down alone deferred once against 211 corrections in Skip's
  // session, which is what `8543d9048` shipped.
  assert.equal(isReaderInputInFlight({ touchScrollActive: true, pointerHeldInPanel: false }), true)
  assert.equal(isReaderInputInFlight({ explicitScrollInput: true }), true)
  assert.equal(isReaderInputInFlight({ pointerHeldInPanel: true }), true)
  assert.equal(isReaderInputInFlight({}), false)
  assert.equal(isReaderInputInFlight(), false)
})

test('following or hard-locked chat does not preserve a reader anchor', () => {
  assert.equal(shouldPreserveChatViewport({ scrolledUp: false, hardLocked: false, hasAnchor: true }), false)
  assert.equal(shouldPreserveChatViewport({ scrolledUp: true, hardLocked: true, hasAnchor: true }), false)
  assert.equal(shouldPreserveChatViewport({ scrolledUp: true, hardLocked: false, hasAnchor: false }), false)
})

test('reader state, not input, decides whether a viewport is preserved at all', () => {
  // The distinction `7430200ad` collapsed: input never decides WHETHER the
  // reader's position is held, only WHEN the correction may be written.
  assert.equal(shouldPreserveChatViewport({ scrolledUp: true, hardLocked: false, hasAnchor: true }), true)
})
