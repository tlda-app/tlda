import test from 'node:test'
import assert from 'node:assert/strict'

import {
  completedLoginIdentity,
  completedRegistrationIdentity,
  shouldAutoAssignTemporaryIdentity,
  shouldUseRequestedIdentity,
} from '../src/fleet/identity-persistence.mjs'

test('queued durable placeholders cannot become browser identity', () => {
  const queued = { ok: true, queued: true, operation_id: 'login-1' }
  assert.throws(() => completedLoginIdentity(queued), /queued without a completed response/)
  assert.throws(() => completedRegistrationIdentity(queued), /queued without a completed response/)
  assert.throws(() => completedLoginIdentity({ ok: true }), /invalid response/)
  assert.throws(() => completedLoginIdentity({ id: 'fleet:skip', name: 'undefined' }), /invalid response/)
  assert.throws(() => completedRegistrationIdentity({ ok: true }), /invalid response/)
  assert.deepEqual(completedLoginIdentity({ id: 'fleet:skip', name: 'skip' }), { id: 'fleet:skip', name: 'skip' })
  assert.deepEqual(completedRegistrationIdentity({ agent: { id: 'fleet:skip' } }), { id: 'fleet:skip' })
})

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
