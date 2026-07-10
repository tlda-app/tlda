import path from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { DAEMON_OUTBOX_ID_FIELD } from '../shared/daemon-delivery.mjs'

export const OUTBOX_ID_FIELD = DAEMON_OUTBOX_ID_FIELD

function nowIso() {
  return new Date().toISOString()
}

function stringifyPayload(payload) {
  return JSON.stringify(payload)
}

function parseRow(row) {
  if (!row) return null
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    attempts: row.attempts,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
  }
}

export class DaemonOutbox {
  constructor(dbPath, { clock = nowIso } = {}) {
    this.dbPath = dbPath
    this.clock = clock
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_outbox (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_attempt_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS daemon_outbox_pending_idx
        ON daemon_outbox(created_at, id);
    `)
    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO daemon_outbox
        (id, type, payload_json, attempts, created_at, last_attempt_at, last_error)
      VALUES
        (@id, @type, @payload_json, 0, @created_at, NULL, NULL)
    `)
    this.listStmt = this.db.prepare(`
      SELECT * FROM daemon_outbox
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `)
    this.ackStmt = this.db.prepare('DELETE FROM daemon_outbox WHERE id = ?')
    this.markAttemptStmt = this.db.prepare(`
      UPDATE daemon_outbox
      SET attempts = attempts + 1,
          last_attempt_at = ?,
          last_error = NULL
      WHERE id = ?
    `)
    this.markErrorStmt = this.db.prepare(`
      UPDATE daemon_outbox
      SET last_error = ?
      WHERE id = ?
    `)
    this.countStmt = this.db.prepare('SELECT count(*) AS count FROM daemon_outbox')
  }

  enqueue(message, { id = null } = {}) {
    const outboxId = id || randomUUID()
    const payload = { ...message, [OUTBOX_ID_FIELD]: outboxId }
    this.insertStmt.run({
      id: outboxId,
      type: message.type || '',
      payload_json: stringifyPayload(payload),
      created_at: this.clock(),
    })
    return outboxId
  }

  pending(limit = 100) {
    return this.listStmt.all(limit).map(parseRow)
  }

  markAttempt(id) {
    this.markAttemptStmt.run(this.clock(), id)
  }

  markError(id, error) {
    this.markErrorStmt.run(String(error?.message || error || 'send failed'), id)
  }

  ack(id) {
    this.ackStmt.run(id)
  }

  count() {
    return this.countStmt.get().count
  }

  close() {
    this.db.close()
  }
}

export function defaultOutboxPath(configDir) {
  return path.join(configDir, 'daemon-outbox.sqlite')
}
