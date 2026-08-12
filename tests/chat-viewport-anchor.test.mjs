import assert from 'node:assert/strict'
import test from 'node:test'

import {
  preserveChatViewportAcrossArrival,
  shouldPreserveChatViewport,
} from '../src/shapes/chatViewportAnchor.mjs'

function arrivalCase({ currentAnchorTop, scrollVelocity = 0, input }) {
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

test('arrival during active scroll preserves viewport offset and does not change velocity', () => {
  const { before, after, result } = arrivalCase({
    currentAnchorTop: 64,
    scrollVelocity: -720,
    input: 'active-wheel',
  })

  assert.equal(after.scrollHeight - before.scrollHeight, 120)
  assert.equal(result.delta, -32)
  assert.equal(result.scrollTop, 1168)
  assert.equal(result.scrollVelocity, -720)
  assert.equal(result.scrollHeight, after.scrollHeight)
})

test('arrival during momentum scroll preserves viewport offset and does not change inertia', () => {
  const { before, after, result } = arrivalCase({
    currentAnchorTop: 141,
    scrollVelocity: 380,
    input: 'momentum-touch',
  })

  assert.equal(after.scrollHeight - before.scrollHeight, 120)
  assert.equal(result.delta, 45)
  assert.equal(result.scrollTop, 1245)
  assert.equal(result.scrollVelocity, 380)
  assert.equal(result.scrollHeight, after.scrollHeight)
})

test('following or hard-locked chat does not preserve a reader anchor', () => {
  assert.equal(shouldPreserveChatViewport({ scrolledUp: false, hardLocked: false, hasAnchor: true }), false)
  assert.equal(shouldPreserveChatViewport({ scrolledUp: true, hardLocked: true, hasAnchor: true }), false)
  assert.equal(shouldPreserveChatViewport({ scrolledUp: true, hardLocked: false, hasAnchor: false }), false)
})
