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
      spawn_policy TEXT NOT NULL,
      permission_profile TEXT,
      permission_intersection TEXT,
      permission_set TEXT,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_permission_grants_updated_at
      ON permission_grants(updated_at);
  `)
  try { db.exec('ALTER TABLE permission_grants ADD COLUMN permission_profile TEXT') } catch (e) {
    if (!String(e?.message || '').includes('duplicate column name')) throw e
  }
  try { db.exec('ALTER TABLE permission_grants ADD COLUMN permission_intersection TEXT') } catch (e) {
    if (!String(e?.message || '').includes('duplicate column name')) throw e
  }
  return db
}

const db = openDb(workerData.dbPath)
const upsert = db.prepare(`
  INSERT INTO permission_grants (id, spawn_policy, permission_profile, permission_intersection, permission_set, updated_at, source)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    spawn_policy = excluded.spawn_policy,
    permission_profile = excluded.permission_profile,
    permission_intersection = excluded.permission_intersection,
    permission_set = excluded.permission_set,
    updated_at = excluded.updated_at,
    source = excluded.source
`)
const remove = db.prepare('DELETE FROM permission_grants WHERE id = ?')

parentPort.on('message', (message) => {
  const { requestId, op } = message || {}
  try {
    if (op === 'upsert') {
      const row = message.row || {}
      upsert.run(row.id, row.spawnPolicy, row.permissionProfile, row.permissionIntersection, row.permissionSet, row.updatedAt, row.source)
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
