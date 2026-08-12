import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldAutoAssignTemporaryIdentity, shouldUseRequestedIdentity } from '../src/fleet/identity-persistence.mjs'

test('requested identity handling waits for a missing current identity', () => {
  assert.equal(shouldUseRequestedIdentity({ needsIdentity: true, id: null, name: null }), true)
  assert.equal(shouldUseRequestedIdentity({ needsIdentity: false, id: null, name: null }), false)
  assert.equal(shouldUseRequestedIdentity({ needsIdentity: true, id: 'fleet:skip', name: null }), false)
  assert.equal(shouldUseRequestedIdentity({ needsIdentity: true, id: null, name: 'skip' }), false)
})

test('temporary identity waits until identity absence is resolved', () => {
  assert.equal(shouldAutoAssignTemporaryIdentity({ identityResolved: false, needsIdentity: true, id: null, name: null }), false)
  assert.equal(shouldAutoAssignTemporaryIdentity({ identityResolved: true, needsIdentity: true, id: null, name: null }), true)
  assert.equal(shouldAutoAssignTemporaryIdentity({ identityResolved: true, needsIdentity: false, id: null, name: null }), false)
  assert.equal(shouldAutoAssignTemporaryIdentity({ identityResolved: true, needsIdentity: true, id: 'fleet:skip', name: null }), false)
  assert.equal(shouldAutoAssignTemporaryIdentity({ identityResolved: true, needsIdentity: true, id: null, name: 'skip' }), false)
})
