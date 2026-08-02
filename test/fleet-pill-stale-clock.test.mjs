import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FLEET_PILL_STALE_MS,
  forgetFleetPill,
  markFleetPillActive,
  markFleetPillInactive,
  shouldReclaimFleetPill,
} from '../src/shapes/fleet-pill-policy.ts'

const IDENTITY = { userId: 'u1', deviceId: 'd1' }

/** A transient pill of Skip's, created at `createdAt`. */
function pill(id, createdAt) {
  return {
    id,
    type: 'fleet-pill',
    props: { userId: 'u1', deviceId: 'd1', createdAt, ephemeral: true },
  }
}

test('a pill nobody touched is reclaimed on its original schedule', (t) => {
  t.after(() => forgetFleetPill('p-untouched'))
  const p = pill('p-untouched', 0)
  assert.equal(shouldReclaimFleetPill(p, FLEET_PILL_STALE_MS - 1, IDENTITY), false)
  assert.equal(shouldReclaimFleetPill(p, FLEET_PILL_STALE_MS, IDENTITY), true)
})

test('a pill being held is never reclaimed, however long the drag runs', (t) => {
  t.after(() => forgetFleetPill('p-held'))
  const p = pill('p-held', 0)
  markFleetPillActive('p-held')
  assert.equal(shouldReclaimFleetPill(p, FLEET_PILL_STALE_MS * 10, IDENTITY), false)
})

test('releasing a pill after a long drag does not reclaim it on the spot', (t) => {
  t.after(() => forgetFleetPill('p-slow-drag'))
  // The regression: the stale budget ran from creation, so a drag lasting longer
  // than FLEET_PILL_STALE_MS meant the deadline had already elapsed while the
  // pill was in hand — and it was destroyed the instant it was put down.
  const p = pill('p-slow-drag', 0)
  const release = FLEET_PILL_STALE_MS * 3

  markFleetPillActive('p-slow-drag')
  markFleetPillInactive('p-slow-drag', release)

  assert.equal(shouldReclaimFleetPill(p, release, IDENTITY), false)
  assert.equal(shouldReclaimFleetPill(p, release + FLEET_PILL_STALE_MS - 1, IDENTITY), false)
})

test('a released pill still goes stale, measured from when it was put down', (t) => {
  t.after(() => forgetFleetPill('p-released'))
  const p = pill('p-released', 0)
  const release = FLEET_PILL_STALE_MS * 3

  markFleetPillActive('p-released')
  markFleetPillInactive('p-released', release)

  assert.equal(shouldReclaimFleetPill(p, release + FLEET_PILL_STALE_MS, IDENTITY), true)
})

test('picking a pill back up restarts the countdown', (t) => {
  t.after(() => forgetFleetPill('p-regrabbed'))
  const p = pill('p-regrabbed', 0)

  markFleetPillActive('p-regrabbed')
  markFleetPillInactive('p-regrabbed', 1_000)
  // Picked up again before it went stale, then put down much later.
  markFleetPillActive('p-regrabbed')
  markFleetPillInactive('p-regrabbed', 50_000)

  assert.equal(shouldReclaimFleetPill(p, 55_000, IDENTITY), false)
  assert.equal(shouldReclaimFleetPill(p, 60_000, IDENTITY), true)
})

test('clearing an inactive pill does not hand it a fresh budget', (t) => {
  t.after(() => forgetFleetPill('p-never-held'))
  // markFleetPillInactive doubles as plain cleanup on pills that were never
  // dragged. Those must keep dying on schedule rather than being kept alive by
  // the tidy-up call itself.
  const p = pill('p-never-held', 0)
  markFleetPillInactive('p-never-held', FLEET_PILL_STALE_MS * 5)
  assert.equal(shouldReclaimFleetPill(p, FLEET_PILL_STALE_MS, IDENTITY), true)
})

test('forgetting a pill drops its release time with it', (t) => {
  t.after(() => forgetFleetPill('p-recycled'))
  const p = pill('p-recycled', 0)
  markFleetPillActive('p-recycled')
  markFleetPillInactive('p-recycled', 100_000)
  assert.equal(shouldReclaimFleetPill(p, 105_000, IDENTITY), false)

  // The record left the store; a later pill reusing the id must not inherit it.
  forgetFleetPill('p-recycled')
  assert.equal(shouldReclaimFleetPill(p, 105_000, IDENTITY), true)
})

test("another person's pill is never reclaimed here", (t) => {
  t.after(() => forgetFleetPill('p-theirs'))
  const theirs = {
    id: 'p-theirs',
    type: 'fleet-pill',
    props: { userId: 'u2', deviceId: 'd2', createdAt: 0, ephemeral: true },
  }
  assert.equal(shouldReclaimFleetPill(theirs, FLEET_PILL_STALE_MS * 10, IDENTITY), false)
})
