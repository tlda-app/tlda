// Tail-11: the agents panel hides dead agents behind its show-dead toggle
// (default off). Every other caller keeps the default.
import assert from 'node:assert/strict'
import test from 'node:test'

import { fleetAgentListed, fleetTableDeadRowToAgent, toFleetAgentDirectoryRow } from '../src/shapes/FleetAgentDirectoryModel.ts'

test('dead agents are hidden by default and listed with showDead', () => {
  const dead = { dead: true, metadata: null }
  assert.equal(fleetAgentListed(dead), false)
  assert.equal(fleetAgentListed(dead, false), false)
  assert.equal(fleetAgentListed(dead, true), true)
})

test('live agents list and hidden agents never do, regardless of the toggle', () => {
  assert.equal(fleetAgentListed({ dead: false, metadata: null }), true)
  assert.equal(fleetAgentListed({ dead: false, metadata: null }, true), true)
  assert.equal(fleetAgentListed({ dead: true, metadata: { hidden: true } }, true), false)
  // Absent rows carry neither flag, so they list — pre-existing behavior,
  // unchanged by the toggle.
  assert.equal(fleetAgentListed(null), true)
  assert.equal(fleetAgentListed(undefined, true), true)
})

test('fleet-table dead rows map onto renderable panel rows', () => {
  const mapped = fleetTableDeadRowToAgent({
    id: 'fleet:gone', name: 'gone', parent_agent_id: null, human: false,
    labels: ['reviewers'], status: 'dead', last_seen_ago_s: 3600, model: 'muse',
    activity: 'unknown',
  })
  assert.equal(mapped.friendly_name, 'gone')
  assert.equal(mapped.dead, true)
  assert.deepEqual(mapped.labels, ['reviewers'])
  assert.ok(mapped.last_seen && !Number.isNaN(new Date(mapped.last_seen).getTime()))
  // The directory row model renders it without throwing — this is the whole
  // panel read surface for a dead row.
  const row = toFleetAgentDirectoryRow(mapped)
  assert.equal(row.exactName, 'gone')
  assert.equal(row.dimmed, true)
  assert.ok(row.hoverTitle.includes('gone'))
})

test('dead humans map without tripping the runtime assert', () => {
  const mapped = fleetTableDeadRowToAgent({
    id: 'fleet:ex', name: 'ex', parent_agent_id: null, human: true,
    labels: [], status: 'dead', last_seen_ago_s: null, model: null,
  })
  assert.equal(mapped.runtime_status.status, 'away')
  const row = toFleetAgentDirectoryRow(mapped)
  assert.equal(row.exactName, 'ex')
})
