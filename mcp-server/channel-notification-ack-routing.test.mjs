import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseToolEnvForFleetRequest } from './fleet-tools.mjs'

test('channel notification acknowledgements stay on the authenticated channel', () => {
  assert.equal(shouldUseToolEnvForFleetRequest('channel-notification-ack'), false)
})

test('other ephemeral requests still use the active tool environment', () => {
  assert.equal(shouldUseToolEnvForFleetRequest('fleet-search'), true)
})
