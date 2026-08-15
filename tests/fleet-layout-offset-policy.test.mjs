import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fleetLayoutDx } from '../src/shapes/fleet-layout-offset-policy.ts'

test('two-margin layouts stay in the document coordinate frame', () => {
  assert.equal(fleetLayoutDx('both-margins', -16000), 0)
})

test('one-sided layouts retain their owner spread', () => {
  assert.equal(fleetLayoutDx('3-col', -16000), -16000)
  assert.equal(fleetLayoutDx('big-chat', -8000), -8000)
})
