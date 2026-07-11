import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldAutoAssignTemporaryIdentity,
} from '../src/fleet/identity-persistence.mjs'

test('anonymous pending identity can receive a temporary identity', () => {
  assert.equal(
    shouldAutoAssignTemporaryIdentity({ needsIdentity: true, id: null, name: null }),
    true,
  )
})

test('pending stored identity is not replaced by a temporary identity', () => {
  assert.equal(
    shouldAutoAssignTemporaryIdentity({ needsIdentity: true, id: null, name: 'skip' }),
    false,
  )
})

test('resolved identity is not replaced by a temporary identity', () => {
  assert.equal(
    shouldAutoAssignTemporaryIdentity({ needsIdentity: true, id: 'fleet:skip', name: 'skip' }),
    false,
  )
})
