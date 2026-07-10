import { randomUUID } from 'crypto'
import { SERVER_DAEMON_OUTBOX_ID_FIELD } from '../../shared/daemon-delivery.mjs'

function nowIso() {
  return new Date().toISOString()
}

function parseRow(row) {
  if (!row) return null
  return {
    id: row.id,
    daemonKey: row.daemon_key,
    dedupeKey: row.dedupe_key,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    attempts: row.attempts,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
  }
}

export class ServerDaemonOutbox {
  constructor(db, { clock = nowIso } = {}) {
    if (!db) throw new Error('ServerDaemonOutbox requires db')
    this.db = db
    this.clock = clock
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_daemon_outbox (
        id TEXT PRIMARY KEY,
        daemon_key TEXT NOT NULL,
        dedupe_key TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_attempt_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS server_daemon_outbox_pending_idx
        ON server_daemon_outbox(daemon_key, created_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS server_daemon_outbox_dedupe_idx
        ON server_daemon_outbox(daemon_key, dedupe_key)
        WHERE dedupe_key IS NOT NULL;
    `)
    this.insertStmt = this.db.prepare(`
      INSERT INTO server_daemon_outbox
        (id, daemon_key, dedupe_key, type, payload_json, attempts, created_at, last_attempt_at, last_error)
      VALUES
        (@id, @daemon_key, @dedupe_key, @type, @payload_json, 0, @created_at, NULL, NULL)
    `)
    this.deleteDedupeStmt = this.db.prepare(`
      DELETE FROM server_daemon_outbox
      WHERE daemon_key = ? AND dedupe_key = ?
    `)
    this.pendingStmt = this.db.prepare(`
      SELECT * FROM server_daemon_outbox
      WHERE daemon_key = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `)
    this.ackStmt = this.db.prepare('DELETE FROM server_daemon_outbox WHERE id = ?')
    this.markAttemptStmt = this.db.prepare(`
      UPDATE server_daemon_outbox
      SET attempts = attempts + 1,
          last_attempt_at = ?,
          last_error = NULL
      WHERE id = ?
    `)
    this.markErrorStmt = this.db.prepare(`
      UPDATE server_daemon_outbox
      SET last_error = ?
      WHERE id = ?
    `)
    this.countStmt = this.db.prepare('SELECT count(*) AS count FROM server_daemon_outbox')
    this.countForDaemonStmt = this.db.prepare('SELECT count(*) AS count FROM server_daemon_outbox WHERE daemon_key = ?')
    this.enqueueTxn = this.db.transaction(({ id, daemonKey, dedupeKey, type, payload, createdAt }) => {
      if (dedupeKey) this.deleteDedupeStmt.run(daemonKey, dedupeKey)
      this.insertStmt.run({
        id,
        daemon_key: daemonKey,
        dedupe_key: dedupeKey || null,
        type,
        payload_json: JSON.stringify(payload),
        created_at: createdAt,
      })
    })
  }

  enqueue(daemonKey, message, { dedupeKey = null, id = null } = {}) {
    if (!daemonKey) throw new Error('server daemon outbox enqueue requires daemonKey')
    const outboxId = id || randomUUID()
    const payload = { ...message, [SERVER_DAEMON_OUTBOX_ID_FIELD]: outboxId }
    this.enqueueTxn({
      id: outboxId,
      daemonKey,
      dedupeKey,
      type: message?.type || '',
      payload,
      createdAt: this.clock(),
    })
    return outboxId
  }

  pendingForDaemon(daemonKey, limit = 100) {
    return this.pendingStmt.all(daemonKey, limit).map(parseRow)
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

  countForDaemon(daemonKey) {
    return this.countForDaemonStmt.get(daemonKey).count
  }
}
