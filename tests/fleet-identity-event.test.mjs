import test from 'node:test'
import assert from 'node:assert/strict'
import { fleetIdentityStateFromEvent } from '../src/fleet/identity-event.ts'

const previous = {
  id: 'fleet:grover-wd2b',
  name: 'grover-wd2b',
  identityResolved: true,
  needsIdentity: false,
}

test('an explicit null identity transition does not reuse the previous identity', () => {
  const next = fleetIdentityStateFromEvent({
    id: null,
    name: 'fleet_2b6fe909',
    identityResolved: true,
    needsIdentity: true,
  }, previous)

  assert.deepEqual(next, {
    id: null,
    name: 'fleet_2b6fe909',
    identityResolved: true,
    needsIdentity: true,
  })
})

test('an explicit null name transition does not reuse the previous name', () => {
  const next = fleetIdentityStateFromEvent({ name: null }, previous)

  assert.equal(next.name, null)
})

test('omitted identity fields still use the current store values', () => {
  assert.deepEqual(fleetIdentityStateFromEvent({}, previous), previous)
})
