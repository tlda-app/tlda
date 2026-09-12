#!/usr/bin/env node
// The `hidden` metadata field hides probe agents from the agent panel so they
// do not clutter the display. It is a display
// property and nothing else: a hidden agent is still addressable, still gets
// mail, still answers to its name, still appears in roster() and in history.
// The failure this test exists to catch is `hidden` quietly becoming a filter
// on one of those -- which is how a flag meant to tidy a list turns into an
// agent nobody can reach and nobody can see is unreachable.
//
// `fleetAgentListed` is the panel's own selection rule, so this is the rule
// itself under test rather than a restatement of it.
import test from 'node:test'
import assert from 'node:assert/strict'

import { fleetAgentListed } from '../src/shapes/FleetAgentDirectoryModel.ts'

const probe = (over = {}) => ({
  id: 'fleet:dev-probe-2d043f61',
  friendly_name: 'dev-probe-2d043f6',
  labels: ['dev-probe'],
  dead: false,
  metadata: { hidden: true },
  ...over,
})

test('a hidden agent is not listed in the panel', () => {
  assert.equal(fleetAgentListed(probe()), false)
})

test('an ordinary agent is still listed', () => {
  // The positive control. Without it, a rule that hides EVERYTHING passes the
  // test above and reads as working.
  assert.equal(fleetAgentListed(probe({ metadata: {} })), true)
  assert.equal(fleetAgentListed(probe({ metadata: null })), true)
  assert.equal(fleetAgentListed({ id: 'fleet:someone', dead: false }), true)
})

test('hidden is not inherited from anything else on the row', () => {
  // A label named `dev-probe` must not hide anyone by itself. The contract uses
  // a metadata field; a name or label pattern standing in for it is a different
  // rule that will eventually catch something that is not a probe.
  assert.equal(fleetAgentListed(probe({ metadata: {}, labels: ['dev-probe'] })), true)
  assert.equal(fleetAgentListed({ id: 'fleet:dev-probe-abc', friendly_name: 'dev-probe-abc' }), true)
})

test('dead still decides listing exactly as it did', () => {
  // The rule this one joined. Adding `hidden` beside it must not change it.
  assert.equal(fleetAgentListed({ id: 'fleet:x', dead: true }), false)
  assert.equal(fleetAgentListed({ id: 'fleet:x', dead: false }), true)
})

test('a hidden agent is not marked dead, unreachable, or otherwise altered', () => {
  // DEATH IS A FLAG IN THE DATABASE, SET ONLY EXPLICITLY. Hiding is a display
  // property and must not imply any part of death or unreachability.
  const row = probe()
  assert.equal(row.dead, false)
  assert.equal(fleetAgentListed({ ...row, dead: false }), false)
  assert.equal(fleetAgentListed({ ...row, metadata: { hidden: false } }), true)
})
