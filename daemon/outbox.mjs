import path from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { DAEMON_OUTBOX_ID_FIELD } from '../shared/daemon-delivery.mjs'

export const OUTBOX_ID_FIELD = DAEMON_OUTBOX_ID_FIELD
export const DEFAULT_MAX_ATTEMPTS = 5

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
    deadLetteredAt: row.dead_lettered_at,
    deadLetterReason: row.dead_letter_reason,
  }
}

export class DaemonOutbox {
  constructor(dbPath, { clock = nowIso, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
    this.dbPath = dbPath
    this.clock = clock
    this.maxAttempts = maxAttempts
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
        last_error TEXT,
        dead_lettered_at TEXT,
        dead_letter_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS daemon_outbox_pending_idx
        ON daemon_outbox(created_at, id)
        WHERE dead_lettered_at IS NULL;
    `)
    this.ensureColumn('daemon_outbox', 'dead_lettered_at', 'TEXT')
    this.ensureColumn('daemon_outbox', 'dead_letter_reason', 'TEXT')
    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO daemon_outbox
        (id, type, payload_json, attempts, created_at, last_attempt_at, last_error)
      VALUES
        (@id, @type, @payload_json, 0, @created_at, NULL, NULL)
    `)
    this.listStmt = this.db.prepare(`
      SELECT * FROM daemon_outbox
      WHERE dead_lettered_at IS NULL
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
    this.deadLetterStmt = this.db.prepare(`
      UPDATE daemon_outbox
      SET last_error = ?,
          dead_lettered_at = ?,
          dead_letter_reason = ?
      WHERE id = ?
    `)
    this.countStmt = this.db.prepare('SELECT count(*) AS count FROM daemon_outbox')
    this.pendingCountStmt = this.db.prepare('SELECT count(*) AS count FROM daemon_outbox WHERE dead_lettered_at IS NULL')
    this.deadLetterCountStmt = this.db.prepare('SELECT count(*) AS count FROM daemon_outbox WHERE dead_lettered_at IS NOT NULL')
    this.getStmt = this.db.prepare('SELECT * FROM daemon_outbox WHERE id = ?')
  }

  ensureColumn(table, name, type) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all()
    if (!cols.some(col => col.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
    }
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

  markError(id, error, { deadLetterEligible = true } = {}) {
    const message = String(error?.message || error || 'send failed')
    this.markErrorStmt.run(message, id)
    const row = this.get(id)
    if (deadLetterEligible && row && row.attempts >= this.maxAttempts) {
      this.deadLetter(id, message)
      return { deadLettered: true, attempts: row.attempts, error: message }
    }
    return { deadLettered: false, attempts: row?.attempts || 0, error: message }
  }

  markTransientError(id, error) {
    const message = String(error?.message || error || 'send failed')
    this.markErrorStmt.run(message, id)
    return { deadLettered: false, attempts: this.get(id)?.attempts || 0, error: message }
  }

  deadLetter(id, reason) {
    const message = String(reason?.message || reason || 'delivery failed')
    this.deadLetterStmt.run(message, this.clock(), message, id)
  }

  get(id) {
    return parseRow(this.getStmt.get(id))
  }

  ack(id) {
    this.ackStmt.run(id)
  }

  count() {
    return this.countStmt.get().count
  }

  pendingCount() {
    return this.pendingCountStmt.get().count
  }

  deadLetterCount() {
    return this.deadLetterCountStmt.get().count
  }

  close() {
    this.db.close()
  }
}

export function defaultOutboxPath(configDir) {
  return path.join(configDir, 'daemon-outbox.sqlite')
}
