import fs from 'fs'
import path from 'path'
import { parentPort, workerData } from 'worker_threads'
import Database from 'better-sqlite3'

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_grants (
      id TEXT PRIMARY KEY,
      permission_grant TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_permission_grants_updated_at
      ON permission_grants(updated_at);
  `)
  return db
}

const db = openDb(workerData.dbPath)
const upsert = db.prepare(`
  INSERT INTO permission_grants (id, permission_grant, updated_at, source)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    permission_grant = excluded.permission_grant,
    updated_at = excluded.updated_at,
    source = excluded.source
`)
const remove = db.prepare('DELETE FROM permission_grants WHERE id = ?')

parentPort.on('message', (message) => {
  const { requestId, op } = message || {}
  try {
    if (op === 'upsert') {
      const row = message.row || {}
      upsert.run(row.id, row.permissionGrant, row.updatedAt, row.source)
      parentPort.postMessage({ requestId, ok: true })
      return
    }
    if (op === 'delete') {
      remove.run(message.id)
      parentPort.postMessage({ requestId, ok: true })
      return
    }
    throw new Error(`unknown permission ledger op "${op}"`)
  } catch (e) {
    parentPort.postMessage({ requestId, ok: false, error: e.message || String(e) })
  }
})
