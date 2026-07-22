// db-writer.worker.mjs — the single writer for fleet.db.
//
// Why this exists: better-sqlite3 is synchronous, so a slow write blocks the
// thread it runs on. The full-text index (events_fts) periodically merges its
// internal segments, and that merge can land on one insert and take ~1.5s. On
// the main thread that freezes the event loop → chat/health drop. Here, on a
// dedicated worker thread, the merge still happens (we index everything) but it
// never touches the loop that serves chat.
//
// This thread OWNS the only write connection. The main thread opens a separate
// read-only connection (WAL lets it read concurrently while we write). No other
// thread writes, so there is never write-lock contention against the main loop.
//
// Protocol (messages from main):
//   { id, kind:'run',   sql, params }      → { id, result:{lastInsertRowid,changes} }
//   { id, kind:'batch', ops:[{sql,params}] } → { id, result:[{lastInsertRowid,changes}] }
//   { id, kind:'exec',  sql }              → { id, result:{} }
// `id` is omitted for fire-and-forget writes (no reply sent).

import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'

const db = new Database(workerData.dbPath)
// WAL: lets the main thread's read connection read while we hold the write lock.
// NORMAL: durable across app crashes; only a power-loss can lose the last txn —
// acceptable, and never corrupts. (The old main-thread conn ran synchronous=OFF.)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('wal_autocheckpoint = 1000')

const stmts = new Map()
function prep(sql) {
  let s = stmts.get(sql)
  if (!s) { s = db.prepare(sql); stmts.set(sql, s) }
  return s
}

function one(sql, params) {
  const r = prep(sql).run(...(params || []))
  return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes }
}

parentPort.on('message', (msg) => {
  const { id, kind } = msg
  try {
    let result
    if (kind === 'run') {
      result = one(msg.sql, msg.params)
    } else if (kind === 'batch') {
      const tx = db.transaction((ops) => ops.map((o, index) => {
        const result = one(o.sql, o.params)
        if (o.expectChanges != null && result.changes !== o.expectChanges) {
          throw new Error(`batch operation ${index} expected ${o.expectChanges} change(s), got ${result.changes}`)
        }
        return result
      }))
      result = tx(msg.ops)
    } else if (kind === 'exec') {
      db.exec(msg.sql); result = {}
    } else {
      throw new Error('unknown write kind: ' + kind)
    }
    if (id != null) parentPort.postMessage({ id, result })
  } catch (e) {
    if (id != null) parentPort.postMessage({ id, error: e.message })
    else parentPort.postMessage({ id: null, error: e.message, sql: msg.sql }) // surface fire-and-forget failures
  }
})

parentPort.postMessage({ ready: true })
