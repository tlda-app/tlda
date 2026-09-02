import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

// Inserting an event must not do housekeeping. On 2026-09-02 the deployed box
// logged a 6024ms activity-FTS prune scan with a chat insert queued behind it
// for 6028.5ms: the sweep hung off `insertEventRecord`, so a write waited on a
// sweep that had nothing to do.
//
// This asserts the boundary and not the timing. A timing test would be a flake
// on a loaded box, and a flaky guard gets disabled and then catches nothing.

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-insert-boundary-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    await fn(store)
  } finally {
    try { store.close?.() } catch { /* a closed store is the goal, not the test */ }
    await rm(dir, { recursive: true, force: true })
  }
}

test('inserting an event never runs the activity-FTS prune', async () => {
  await withStore(async store => {
    // Spy rather than assert on absence of a method name: the claim is about
    // what an insert DOES, so it has to survive the sweep being reached by any
    // route, including a renamed helper.
    let pruneCalls = 0
    const realPrune = store.pruneActivityEventsFts.bind(store)
    store.pruneActivityEventsFts = (...args) => { pruneCalls++; return realPrune(...args) }

    for (let i = 0; i < 3; i++) {
      await store.insertEventRecord({
        type: 'activity',
        from: 'fleet:alpha',
        to: 'fleet:beta',
        text: `tool call ${i}`,
      })
    }

    assert.equal(pruneCalls, 0, 'insertEventRecord must not invoke activity-FTS pruning')
  })
})

test('the prune still works when called explicitly, and is idempotent', async () => {
  await withStore(async store => {
    // The positive control for the test above: if the sweep were broken or
    // unreachable, `pruneCalls === 0` would pass for the wrong reason. This
    // proves the method the spy wraps is real and does its job.
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    for (let i = 0; i < 5; i++) {
      await store.insertEventRecord({
        type: 'activity',
        from: 'fleet:alpha',
        to: 'fleet:beta',
        text: `ancient tool call ${i}`,
        timestamp: old,
      })
    }

    const first = store.pruneActivityEventsFts()
    assert.ok(first.deleted > 0, 'an explicit sweep still prunes eligible rows')

    // Re-running converges rather than repeating work. FTS5 has no "delete if
    // present", so a second delete of the same rowid would corrupt the index.
    const second = store.pruneActivityEventsFts()
    assert.equal(second.deleted, 0, 'a second sweep finds nothing left to prune')
    assert.equal(second.through, first.through, 'the watermark does not move on an empty sweep')
  })
})
