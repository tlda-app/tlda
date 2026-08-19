// A name that has been handed on must still resolve to everyone who held it.
//
// This is the silent-and-destructive class: when it fails, a read of a former
// holder's whole history returns zero, and a zero is indistinguishable from an
// empty world. On 2026-08-18 three agents, two of them chiefs, reported a full
// day of another agent's work as never having happened, because `chief` had
// rotated to a new holder and every read through the old name came back empty.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-name-handoff-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    return run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a renamed agent stays reachable by the name it no longer holds', () => withStore(store => {
  store.upsertAgent({
    id: 'fleet:former',
    friendly_name: 'chief',
    registered_at: '2026-08-18T00:00:00.000Z',
  })
  // The handoff: the name moves to a different agent.
  store.upsertAgent({ id: 'fleet:former', friendly_name: 'solved-non-problems' })
  store.upsertAgent({
    id: 'fleet:current',
    friendly_name: 'chief',
    registered_at: '2026-08-18T12:00:00.000Z',
  })

  const byOldName = store.resolveAgentQuery('chief')
  assert.ok(byOldName.includes('fleet:current'), 'the current holder resolves')
  assert.ok(
    byOldName.includes('fleet:former'),
    'the agent that held the name earlier resolves too — otherwise its history reads as empty',
  )

  // The new name keeps working, and an id is always its own address.
  assert.deepEqual(store.resolveAgentQuery('solved-non-problems'), ['fleet:former'])
  assert.deepEqual(store.resolveAgentQuery('fleet:former'), ['fleet:former'])
}))

// The live shape of the failure: the name also names a LINEAGE. The lineage
// branch returned its stack and never reached the name-history lookup below it,
// so the name resolved to the agent occupying the seat now and to nobody who
// occupied it before.
test('a lineage name resolves past its stack, not only to it', () => withStore(store => {
  store.upsertAgent({
    id: 'fleet:pre-lineage',
    friendly_name: 'chief',
    registered_at: '2026-08-18T00:00:00.000Z',
  })
  store.upsertAgent({ id: 'fleet:pre-lineage', friendly_name: 'retired-chief' })

  const lineage = store.getOrCreateLineage('chief')
  store.upsertAgent({
    id: 'fleet:seated',
    friendly_name: 'chief',
    registered_at: '2026-08-18T12:00:00.000Z',
  })
  store.db.prepare(
    `INSERT INTO lineage_stack_entries (lineage_id, fleet_id, stack_index, active, entered_at, entry_reason)
     VALUES (?, ?, 0, 1, ?, 'test')`,
  ).run(lineage.id, 'fleet:seated', '2026-08-18T12:00:00.000Z')

  const ids = store.resolveAgentQuery('chief')
  assert.ok(ids.includes('fleet:seated'), 'the seated occupant resolves')
  assert.ok(
    ids.includes('fleet:pre-lineage'),
    'a lineage stack must not stand in for the whole resolution — it used to return early here, '
    + 'which is how a former holder\'s entire history read as zero',
  )
}))
