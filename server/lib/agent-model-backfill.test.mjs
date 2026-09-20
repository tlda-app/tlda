// `metadata.model` records, by alias, the model an agent actually ran under.
// Skip: "we are not supposed to record the requested model, ie nothing for
// default ... we are supposed to record (by alias) the one used ... this field
// is not supposed to be blank."
//
// It was blank on 2,499 of 4,518 live agents, and the panel hid that by
// printing `sonnet` for every blank — an inference that was meant to BE this
// migration and became a permanent display rule instead.
//
// The filled value is a guess and is meant to be: "if we dont have the record
// just like, make something up". What these tests pin is that the guess is the
// era's default rather than one value for everything, that a human gets
// `human`, and that a recorded model is never overwritten — a migration that
// talks over real data is worse than the blank it replaced.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'

async function withStore(seed, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-model-backfill-'))
  const path = join(dir, 'fleet.db')
  // The migration runs in the CONSTRUCTOR, so the seeding store already ran it
  // against an empty database and keyed itself done. Un-key it after seeding so
  // the second store meets the rows the way a real deployment does — an
  // existing database with blanks already in it.
  const seeding = new FleetStore(path, { taskDoc: false })
  seed(seeding)
  seeding.db.prepare('DELETE FROM store_migrations WHERE name = ?').run('agent-model-backfill-v1')
  seeding.close?.()
  const migrated = new FleetStore(path, { taskDoc: false })
  try {
    await fn(migrated)
  } finally {
    migrated.close?.()
    await rm(dir, { recursive: true, force: true })
  }
}

const modelOf = (store, id) => store.getAgent(id)?.metadata?.model ?? null

test('a blank model is filled with the default of the era it was minted in', () => withStore(
  (store) => {
    store.upsertAgent({ id: 'fleet:old', friendly_name: 'old', human: false, registered_at: '2026-07-01T00:00:00.000Z', last_seen: '2026-07-01T00:00:00.000Z' })
    store.upsertAgent({ id: 'fleet:new', friendly_name: 'new', human: false, registered_at: '2026-09-01T00:00:00.000Z', last_seen: '2026-09-01T00:00:00.000Z' })
  },
  (store) => {
    assert.equal(modelOf(store, 'fleet:old'), 'sonnet', 'before 2026-08-23 a blank meant the sonnet default')
    assert.equal(modelOf(store, 'fleet:new'), 'muse', 'after it, a blank meant muse')
  },
))

test('a human is recorded as human, which is not a guess', () => withStore(
  (store) => {
    store.upsertAgent({ id: 'fleet:person', friendly_name: 'person', human: true, registered_at: '2026-07-01T00:00:00.000Z', last_seen: '2026-07-01T00:00:00.000Z' })
  },
  (store) => {
    assert.equal(modelOf(store, 'fleet:person'), 'human')
  },
))

test('a recorded model is never overwritten', () => withStore(
  (store) => {
    store.upsertAgent({ id: 'fleet:known', friendly_name: 'known', human: false, registered_at: '2026-07-01T00:00:00.000Z', last_seen: '2026-07-01T00:00:00.000Z', metadata: { model: 'opus' } })
  },
  (store) => {
    assert.equal(modelOf(store, 'fleet:known'), 'opus', 'the seat’s own record wins over any guess')
  },
))

test('it runs once and leaves later blanks alone', () => withStore(
  (store) => {
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'a', human: false, registered_at: '2026-09-01T00:00:00.000Z', last_seen: '2026-09-01T00:00:00.000Z' })
  },
  (store) => {
    assert.equal(modelOf(store, 'fleet:a'), 'muse')
    // A row created after the migration ran is the mint's problem, not the
    // migration's — re-running on every start could not tell a never-recorded
    // model from a deliberately cleared one.
    store.upsertAgent({ id: 'fleet:later', friendly_name: 'later', human: false, registered_at: '2026-09-20T00:00:00.000Z', last_seen: '2026-09-20T00:00:00.000Z' })
    assert.equal(modelOf(store, 'fleet:later'), null, 'the migration is keyed and does not run again')
  },
))
