#!/usr/bin/env node
// One-shot builder for idx_session_entries_ts, run OUT OF BAND.
//
// Why this is a separate process and not a line in FleetStore's boot-path index
// block. `session_entries` is 816,736 rows in a 10.6 GB fleet.db, and the global
// history query that scans it was measured on the live box at 21.2 seconds.
// CREATE INDEX has to do that same read plus a sort, so this costs tens of
// seconds on a database of that size. Two places it therefore must not run:
//
//   - the server boot path, which would block the port opening for that long;
//   - the FleetStore worker thread, which holds the only fleet.db connection and
//     serves every store call one at a time. A build there would queue every
//     read and write behind it, which is the same stall this index exists to
//     remove, just relocated.
//
// So: own process, own connection. In WAL a writer blocks no reader, so the
// server keeps serving reads throughout. It does hold the write lock, which is
// why FleetStore's connection now opens with a busy timeout longer than this
// build (see fleet-store.mjs).
//
// Crash safety is SQLite's, not ours. CREATE INDEX is a single transaction: a
// restart mid-build rolls it back and leaves no index and no partial state. The
// next boot runs this again, and IF NOT EXISTS makes an already-built index a
// no-op that exits in milliseconds.

import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'

const INDEX = 'idx_session_entries_ts'
const dbPath = process.argv[2] || process.env.TLDA_FLEET_DB
  || path.join(os.homedir(), '.config', 'tlda', 'fleet.db')

const log = (...a) => console.log('[session-history-index]', ...a)

// Every exit here sets process.exitCode and returns rather than calling
// process.exit(), so the close below actually runs and checkpoints the WAL.
// process.exit() terminates before `finally`, which would leave the WAL for
// the next opener to recover — survivable, and pointless to choose.
function build(db) {
  const present = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?"
  ).get(INDEX)
  if (present) {
    log(`${INDEX} already present; nothing to do`)
    return 0
  }

  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_entries'"
  ).get()
  if (!table) {
    log('no session_entries table in this database; nothing to do')
    return 0
  }

  log(`building ${INDEX} on ${dbPath} — the fleet keeps serving reads; writes wait`)
  const started = Date.now()
  db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON session_entries(timestamp DESC)`)
  log(`built in ${((Date.now() - started) / 1000).toFixed(2)}s`)
  return 0
}

let db
try {
  db = new Database(dbPath)
} catch (err) {
  log(`could not open ${dbPath}: ${err.message}`)
  process.exitCode = 1
}

if (db) {
  try {
    process.exitCode = build(db)
  } catch (err) {
    // Reported, not rethrown. A failure leaves the database exactly as it was
    // and global session history exactly as slow as it was; the exit code says
    // so. Rethrowing would add an unhandled-rejection stack to the server log
    // for a condition the next boot retries by itself.
    log(`build failed, index not created: ${err.message}`)
    process.exitCode = 1
  } finally {
    db.close()
  }
}
