import assert from 'node:assert/strict'
import test from 'node:test'

import {
  storedIdentityLoginFailureAction,
  temporaryIdentityName,
} from '../src/fleet/identity-persistence.mjs'

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

test('temporary identity names are real Sesame Street identities', () => {
  const allowed = /^(big-bird|cookie|grover|oscar|snuffy|abby|bert|ernie|count)-[a-z0-9]{4}$/
  for (let i = 0; i < 20; i++) {
    assert.match(temporaryIdentityName(), allowed)
  }
})
