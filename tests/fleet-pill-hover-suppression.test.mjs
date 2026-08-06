import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasActiveFleetPill,
  markFleetPillActive,
  markFleetPillInactive,
} from '../src/shapes/fleet-pill-policy.ts'

test('native fleet-pill translation suppresses hover surfaces until the drag ends', () => {
  markFleetPillActive('shape:test-pill')
  assert.equal(hasActiveFleetPill(), true)

  markFleetPillInactive('shape:test-pill')
  assert.equal(hasActiveFleetPill(), false)
})
