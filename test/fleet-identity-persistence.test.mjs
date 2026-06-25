import assert from 'node:assert/strict'
import test from 'node:test'

import { storedIdentityLoginFailureAction } from '../src/fleet/identity-persistence.mjs'

test('stored identity is registered on a fresh server with no matching human row', () => {
  assert.equal(
    storedIdentityLoginFailureAction(new Error('No agent named "skip". Register first.')),
    'register-stored',
  )
})

test('stored identity survives transient login failures for reconnect retry', () => {
  assert.equal(storedIdentityLoginFailureAction(new Error('timeout')), 'retry-stored')
  assert.equal(storedIdentityLoginFailureAction(new Error('not connected')), 'retry-stored')
})
