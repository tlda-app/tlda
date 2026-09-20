// The daemon outbox ledger is pruned by `processed_at`, and until this
// migration nothing indexed that column.
//
// `_pruneDaemonOutboxLedger` runs `DELETE FROM daemon_outbox_processed WHERE
// processed_at < ?` hourly. Measured on the live database 2026-09-20, before
// the index: EXPLAIN QUERY PLAN said `SCAN daemon_outbox_processed`, the table
// held 2,207,067 rows, and the number older than the 7-day retention was ZERO.
// So the store's single worker read 2.2 million rows to delete none of them,
// once an hour, with every other fleet operation queued behind it —
// `slowestRun` recorded markDaemonOutboxProcessed at 10,395ms.
//
// What these tests pin is the PLAN, not the presence of an index. An index
// that exists and is not chosen fixes nothing, and "the index is there" is
// exactly the assertion that would keep passing while the scan came back.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'

const PRUNE_SQL = 'DELETE FROM daemon_outbox_processed WHERE processed_at < ?'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-outbox-prune-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try { await fn(store) } finally { store.close?.(); await rm(dir, { recursive: true, force: true }) }
}

const planFor = (store, sql, ...args) =>
  store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(r => r.detail).join(' | ')

test('the prune seeks on processed_at instead of scanning the ledger', () => withStore(async (store) => {
  const plan = planFor(store, PRUNE_SQL, '2026-09-13')
  assert.match(plan, /SEARCH/, `expected a seek, got: ${plan}`)
  assert.doesNotMatch(plan, /\bSCAN daemon_outbox_processed\b/, `still scanning: ${plan}`)
  assert.match(plan, /idx_daemon_outbox_processed_at/, `not using the index: ${plan}`)
}))

test('without the index the same query scans — the control', () => withStore(async (store) => {
  // Establishes that the assertion above is measuring the index and not some
  // property the table has anyway. Drop it and the defect comes straight back.
  store.db.exec('DROP INDEX idx_daemon_outbox_processed_at')
  const plan = planFor(store, PRUNE_SQL, '2026-09-13')
  assert.match(plan, /\bSCAN daemon_outbox_processed\b/, `expected the scan back, got: ${plan}`)
}))

test('pruning still removes exactly the rows past retention', () => withStore(async (store) => {
  // The index must not change the answer, only the cost.
  const insert = store.db.prepare('INSERT INTO daemon_outbox_processed (id, type, processed_at) VALUES (?, ?, ?)')
  insert.run('old-1', 'chat', '2026-01-01T00:00:00.000Z')
  insert.run('old-2', 'chat', '2026-02-01T00:00:00.000Z')
  insert.run('fresh', 'chat', new Date().toISOString())

  const removed = store.db.prepare(PRUNE_SQL).run('2026-06-01T00:00:00.000Z').changes
  assert.equal(removed, 2, 'both stale rows go')

  const left = store.db.prepare('SELECT id FROM daemon_outbox_processed ORDER BY id').all().map(r => r.id)
  assert.deepEqual(left, ['fresh'], 'and the fresh one stays — the ledger is load-bearing for at-most-once delivery')
}))

test('the migration is keyed and does not rebuild on every start', () => withStore(async (store) => {
  const ran = store.db.prepare('SELECT count(*) c FROM store_migrations WHERE name = ?')
    .get('daemon-outbox-processed-at-index-v1').c
  assert.equal(ran, 1)
  // Constructing again against the same file must not run it a second time:
  // CREATE INDEX is a full pass over the table, and on the live ledger that is
  // 2.2M rows of work to do nothing.
  const second = new FleetStore(store.dbPath, { taskDoc: false })
  try {
    const again = second.db.prepare('SELECT count(*) c FROM store_migrations WHERE name = ?')
      .get('daemon-outbox-processed-at-index-v1').c
    assert.equal(again, 1, 'keyed, so the second start skips it')
  } finally { second.close?.() }
}))
