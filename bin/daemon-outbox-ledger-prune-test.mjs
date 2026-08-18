#!/usr/bin/env node
// The daemon outbox at-most-once ledger must be pruned, and must still work.
//
// It is load-bearing: a daemon redelivers an envelope it did not see acked, and
// this ledger is how the server recognises one it already handled. So the risk
// in pruning is that a redelivered envelope stops being recognised and gets
// processed twice.
//
// It had never been pruned at all. Measured on the live database 2026-08-18:
// 6,376,523 rows, 621 MB, spanning 2026-07-10 to that moment — a CREATE, a
// SELECT, an INSERT, and no DELETE anywhere in the tree.
//
// So this asserts both directions: a recent envelope is still recognised after
// a prune, and an ancient one is gone.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TLDA_DAEMON_OUTBOX_LEDGER_RETENTION_DAYS = '7'
process.env.TLDA_DAEMON_OUTBOX_LEDGER_PRUNE_INTERVAL_MS = '0'

const { FleetStore } = await import('../server/lib/fleet-store.mjs')

const dir = mkdtempSync(join(tmpdir(), 'tlda-outbox-ledger-'))
let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}: ${e.message}`)
  }
}

const iso = daysAgo => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()

try {
  const store = new FleetStore(join(dir, 'fleet.db'))

  store.markDaemonOutboxProcessed('recent-envelope', 'activity-event', iso(1))
  store.markDaemonOutboxProcessed('ancient-envelope', 'activity-event', iso(30))

  check('a recent envelope is still recognised — this is the whole point of the ledger', () => {
    assert.equal(store.daemonOutboxWasProcessed('recent-envelope'), true)
  })

  check('an envelope older than the retention is pruned', () => {
    // The prune runs on the next mark, with the interval set to 0 above.
    store.markDaemonOutboxProcessed('trigger', 'activity-event', iso(0))
    assert.equal(store.daemonOutboxWasProcessed('ancient-envelope'), false,
      'a 30-day-old row must not survive a 7-day retention')
  })

  check('and the recent one survived that prune', () => {
    assert.equal(store.daemonOutboxWasProcessed('recent-envelope'), true,
      'pruning must not break redelivery recognition')
  })

  check('an unknown envelope is not recognised', () => {
    assert.equal(store.daemonOutboxWasProcessed('never-seen'), false)
  })

  store.close?.()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS daemon outbox ledger prune' : `FAIL daemon outbox ledger prune (${failures})`)
process.exit(failures === 0 ? 0 : 1)
