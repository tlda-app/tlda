#!/usr/bin/env node
import Database from 'better-sqlite3'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: permission-grants-v1.mjs <fleet-daemon.db>')
  process.exit(2)
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeStoredPermissionGrant(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const profiles = Array.isArray(value?.profiles)
    ? value.profiles.map((name) => String(name || '').trim()).filter(Boolean)
    : []
  const unique = [...new Set(profiles)]
  if (value?.type !== 'permission-intersection' || unique.length < 2) {
    throw new Error('historical permission grant cannot be represented as a configured profile grant')
  }
  return { type: 'permission-intersection', profiles: unique }
}

const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

const columns = db.prepare('PRAGMA table_info(permission_grants)').all().map(row => row.name)
if (columns.includes('permission_grant')) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO ledger_meta (key, value, updated_at)
    VALUES ('permission-ledger-schema', 'permission-grant-v1', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(nowIso())
  db.close()
  process.exit(0)
}

const rows = db.prepare('SELECT * FROM permission_grants').all()
const migrated = rows.map(row => {
  let raw = null
  if (row.permission_intersection) raw = JSON.parse(row.permission_intersection)
  else if (row.permission_profile) raw = row.permission_profile
  if (!raw) {
    throw new Error(`historical permission grant row ${row.id} has no representable configured profile grant`)
  }
  return { ...row, permission_grant: JSON.stringify(normalizeStoredPermissionGrant(raw)) }
})

const transaction = db.transaction(() => {
  db.exec(`
    DROP TABLE IF EXISTS permission_grants_next;
    CREATE TABLE permission_grants_next (
      id TEXT PRIMARY KEY,
      permission_grant TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL,
      friendly_name TEXT,
      session_id TEXT,
      session_kind TEXT,
      session_path TEXT,
      tmux_session TEXT,
      model TEXT,
      machine_id TEXT,
      env_name TEXT,
      daemon_key TEXT,
      terminal_capability TEXT,
      cwd TEXT,
      last_seen TEXT
    );
  `)
  const insert = db.prepare(`
    INSERT INTO permission_grants_next (
      id, permission_grant, updated_at, source, friendly_name, session_id,
      session_kind, session_path, tmux_session, model, machine_id, env_name,
      daemon_key, terminal_capability, cwd, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of migrated) {
    insert.run(
      row.id, row.permission_grant, row.updated_at, row.source,
      row.friendly_name || null, row.session_id || null, row.session_kind || null,
      row.session_path || null, row.tmux_session || null, row.model || null,
      row.machine_id || null, row.env_name || null, row.daemon_key || null,
      row.terminal_capability || null, row.cwd || null, row.last_seen || null,
    )
  }
  db.exec(`
    DROP TABLE permission_grants;
    ALTER TABLE permission_grants_next RENAME TO permission_grants;
    CREATE TABLE IF NOT EXISTS ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO ledger_meta (key, value, updated_at)
    VALUES ('permission-ledger-schema', 'permission-grant-v1', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(nowIso())
})

transaction()
db.close()
