import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FLEET_PILL_STALE_MS,
  isFleetPillActive,
  markFleetPillActive,
  markFleetPillInactive,
  shouldReclaimFleetPill,
} from '../src/shapes/fleet-pill-policy'

const identity = { userId: 'fleet:reader', deviceId: 'phone' }
const pill = (props: Record<string, unknown>, id = 'shape:pill') => ({ id, type: 'fleet-pill', props })

test('reclaims hydrated local transient pills only after their durable age', () => {
  const shape = pill({ ...identity, createdAt: 1_000, ephemeral: true })
  assert.equal(shouldReclaimFleetPill(shape, 1_000 + FLEET_PILL_STALE_MS - 1, identity), false)
  assert.equal(shouldReclaimFleetPill(shape, 1_000 + FLEET_PILL_STALE_MS, identity), true)
})

test('does not reclaim another user or device transient pill', () => {
  const now = FLEET_PILL_STALE_MS + 1
  assert.equal(shouldReclaimFleetPill(pill({ userId: 'fleet:other', deviceId: 'phone', createdAt: 0, ephemeral: true }), now, identity), false)
  assert.equal(shouldReclaimFleetPill(pill({ userId: 'fleet:reader', deviceId: 'tablet', createdAt: 0, ephemeral: true }), now, identity), false)
})

test('legacy ownerless fleet pills are transient, but active local drags are protected', () => {
  const shape = pill({ w: 70, h: 18 })
  assert.equal(shouldReclaimFleetPill(shape, Date.now(), identity), true)
  markFleetPillActive(shape.id)
  assert.equal(isFleetPillActive(shape.id), true)
  assert.equal(shouldReclaimFleetPill(shape, Date.now(), identity), false)
  markFleetPillInactive(shape.id)
  assert.equal(shouldReclaimFleetPill(shape, Date.now(), identity), true)
})

test('never reclaims a non-ephemeral record', () => {
  assert.equal(shouldReclaimFleetPill(pill({ ...identity, createdAt: 0, ephemeral: false }), Date.now(), identity), false)
})
