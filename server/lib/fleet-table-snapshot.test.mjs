// `/api/fleet-table` used to make three sequential store awaits. The store
// worker handles one message at a time, so those were three turns in a queue,
// not three queries — measured on the live server 2026-09-19, the three were
// 54,312 of 391,703 calls through the worker (13.9%), and the one that reads an
// in-memory view and issues no SQL at all carried the worst mean wait of any
// method (106ms). It was queued, not slow.
//
// What these tests pin is that folding them into one call did not change any
// answer, and — the part that could fail silently — that the composite result
// still gets `runtime_status` stamped on BOTH of its agent arrays. An unstamped
// row reads as hibernating, and these are exactly the rows people read to
// decide whether an agent is alive.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import { FLEET_STORE_METHODS } from './fleet-store-methods.mjs'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-fleet-table-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try { await fn(store) } finally { store.close?.(); await rm(dir, { recursive: true, force: true }) }
}

const seen = '2026-09-19T21:00:00.000Z'
const agent = (id, extra = {}) => ({
  id, friendly_name: id.replace('fleet:', ''), human: false,
  registered_at: seen, last_seen: seen, ...extra,
})

test('the snapshot carries exactly what the three calls carried', () => withStore(async (store) => {
  store.upsertAgent(agent('fleet:alive-1'))
  store.upsertAgent(agent('fleet:alive-2'))
  store.upsertAgent(agent('fleet:shell-1', { metadata: { shell: 1 } }))

  const snapshot = store.getFleetTableSnapshot()

  assert.deepEqual(
    snapshot.roster.map(a => a.id).sort(),
    store.getAliveAgents().map(a => a.id).sort(),
    'roster must be the same rows getAliveAgents returns',
  )
  assert.deepEqual(
    snapshot.pendingShells.map(a => a.id),
    store.getPendingShellAgents().map(a => a.id),
    'shells must be the same rows getPendingShellAgents returns',
  )
  assert.deepEqual(
    snapshot.wholeFleet,
    store.getAgentSummary(),
    'totals must be the same object getAgentSummary returns',
  )
}))

test('a pending shell is in the shells and not in the roster', () => withStore(async (store) => {
  // The distinction the route depends on: it merges shells in only when the
  // caller filtered, so a composite that blurred the two would flood the
  // unfiltered roster with never-booted rows.
  store.upsertAgent(agent('fleet:real'))
  store.upsertAgent(agent('fleet:never-booted', { metadata: { shell: 1 } }))

  const { roster, pendingShells } = store.getFleetTableSnapshot()

  assert.ok(roster.some(a => a.id === 'fleet:real'))
  assert.ok(!roster.some(a => a.id === 'fleet:never-booted'), 'a shell is not on the roster')
  assert.ok(pendingShells.some(a => a.id === 'fleet:never-booted'))
}))

test('the method is proxied to the worker', () => {
  // A method absent from this list is simply missing on the client, and the
  // route calls it with `?.()` — so the failure would be an empty roster and a
  // 200, not an error.
  assert.ok(FLEET_STORE_METHODS.includes('getFleetTableSnapshot'))
})

// The stamping half. `_stampAgents` is shape-dispatched by design (the file
// argues against sniffing), so a new composite shape that nobody taught it
// about returns rows with no runtime_status — which reads as hibernating.
test('runtime_status is stamped on both arrays of the composite', async () => {
  const { FleetStoreClient } = await import('./fleet-store-client.mjs')
  const stamp = FleetStoreClient.prototype._stampAgents
  const client = { _projectRuntimeStatus: (a) => (a.id === 'fleet:up' ? 'awake' : 'hibernating') }

  const out = stamp.call(client, {
    roster: [{ id: 'fleet:up' }],
    pendingShells: [{ id: 'fleet:shell' }],
    wholeFleet: { total: 2 },
  }, 'fleetTable')

  assert.equal(out.roster[0].runtime_status, 'awake', 'roster rows must be stamped')
  assert.equal(out.pendingShells[0].runtime_status, 'hibernating', 'shell rows must be stamped too')
  assert.deepEqual(out.wholeFleet, { total: 2 }, 'the totals pass through untouched')
})

test('the stamper is what puts runtime_status there', async () => {
  // Positive control for the test above: with no projector installed the field
  // is absent, so the assertions above are measuring the stamping and not some
  // value the rows carried in already.
  const { FleetStoreClient } = await import('./fleet-store-client.mjs')
  const out = FleetStoreClient.prototype._stampAgents.call(
    { _projectRuntimeStatus: null },
    { roster: [{ id: 'fleet:up' }], pendingShells: [], wholeFleet: null },
    'fleetTable',
  )
  assert.equal(out.roster[0].runtime_status, undefined)
})
