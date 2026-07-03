import fs from 'fs'
import path from 'path'
import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS privilege_grants (
      id TEXT PRIMARY KEY,
      spawn_policy TEXT NOT NULL,
      privilege_set TEXT,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_privilege_grants_updated_at
      ON privilege_grants(updated_at);
  `)
  return db
}

const db = openDb(workerData.dbPath)
const upsert = db.prepare(`
  INSERT INTO privilege_grants (id, spawn_policy, privilege_set, updated_at, source)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    spawn_policy = excluded.spawn_policy,
    privilege_set = excluded.privilege_set,
    updated_at = excluded.updated_at,
    source = excluded.source
`)
const remove = db.prepare('DELETE FROM privilege_grants WHERE id = ?')

parentPort.on('message', (message) => {
  const { requestId, op } = message || {}
  try {
    if (op === 'upsert') {
      const row = message.row || {}
      upsert.run(row.id, row.spawnPolicy, row.privilegeSet, row.updatedAt, row.source)
      parentPort.postMessage({ requestId, ok: true })
      return
    }
    if (op === 'delete') {
      remove.run(message.id)
      parentPort.postMessage({ requestId, ok: true })
      return
    }
    throw new Error(`unknown privilege ledger op "${op}"`)
  } catch (e) {
    parentPort.postMessage({ requestId, ok: false, error: e.message || String(e) })
  }
})
