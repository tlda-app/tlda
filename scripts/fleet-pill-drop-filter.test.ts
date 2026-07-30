import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FLEET_TEAM_FROM_ROLE,
  FLEET_TEAM_TO_ROLE,
} from '../shared/filter-semantics.mjs'
import { fleetFilterForPillDrop } from '../src/shapes/fleet-pill-drop-filter'

test('agent and label drops default to to/from chat filters', () => {
  assert.deepEqual(fleetFilterForPillDrop('agent', 'app-librarian'), [
    [['to', 'app-librarian']],
    [['from', 'app-librarian']],
  ])
  assert.deepEqual(fleetFilterForPillDrop('label', 'awake'), [
    [['to', 'awake']],
    [['from', 'awake']],
  ])
})

test('team drops default to team-aware to/from chat filters', () => {
  assert.deepEqual(fleetFilterForPillDrop('team', 'fleet:parent'), [
    [[FLEET_TEAM_TO_ROLE, 'fleet:parent']],
    [[FLEET_TEAM_FROM_ROLE, 'fleet:parent']],
  ])
})
