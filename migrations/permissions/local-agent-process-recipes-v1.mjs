#!/usr/bin/env node
import Database from 'better-sqlite3'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: local-agent-process-recipes-v1.mjs <fleet-daemon.db>')
  process.exit(2)
}

function nowIso() {
  return new Date().toISOString()
}

const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')

const columns = db.prepare('PRAGMA table_info(local_agent_process_recipes)').all().map(row => row.name)
if (columns.includes('permission_grant')) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_agent_ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO local_agent_ledger_meta (key, value, updated_at)
    VALUES ('local-agent-process-recipes-schema', 'permission-grant-v1', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(nowIso())
  db.close()
  process.exit(0)
}

const rows = db.prepare('SELECT * FROM local_agent_process_recipes').all()
const transaction = db.transaction(() => {
  db.exec(`
    CREATE TABLE local_agent_process_recipes_next (
      local_agent_id TEXT PRIMARY KEY REFERENCES local_agents(local_agent_id) ON DELETE CASCADE,
      tmux_name TEXT,
      cwd TEXT,
      permission_grant TEXT
    );
  `)
  const insert = db.prepare('INSERT INTO local_agent_process_recipes_next VALUES (?, ?, ?, ?)')
  for (const row of rows) {
    if (!row.permission_profile) {
      throw new Error(`historical local process recipe ${row.local_agent_id} has no configured profile grant`)
    }
    insert.run(row.local_agent_id, row.tmux_name, row.cwd, JSON.stringify(row.permission_profile))
  }
  db.exec(`
    DROP TABLE local_agent_process_recipes;
    ALTER TABLE local_agent_process_recipes_next RENAME TO local_agent_process_recipes;
    CREATE TABLE IF NOT EXISTS local_agent_ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db.prepare(`
    INSERT INTO local_agent_ledger_meta (key, value, updated_at)
    VALUES ('local-agent-process-recipes-schema', 'permission-grant-v1', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(nowIso())
})

transaction()
db.close()
