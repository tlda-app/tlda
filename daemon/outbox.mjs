import path from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { DAEMON_OUTBOX_ID_FIELD } from '../shared/daemon-delivery.mjs'
import { SqliteTransportOutbox, parseTransportOutboxRow } from '../shared/fleet-transport.mjs'

export const OUTBOX_ID_FIELD = DAEMON_OUTBOX_ID_FIELD
export const DEFAULT_MAX_ATTEMPTS = 5

function nowIso() {
  return new Date().toISOString()
}

function parseRow(row) {
  const parsed = parseTransportOutboxRow(row)
  if (!parsed) return null
  return {
    ...parsed,
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
    this.queue = new SqliteTransportOutbox(this.db, {
      tableName: 'daemon_outbox',
      clock,
      extraColumns: [
        { name: 'dead_lettered_at', definition: 'TEXT' },
        { name: 'dead_letter_reason', definition: 'TEXT' },
      ],
      indexes: [
        `CREATE INDEX IF NOT EXISTS daemon_outbox_pending_idx
          ON daemon_outbox(created_at, id)
          WHERE dead_lettered_at IS NULL`,
        `CREATE INDEX IF NOT EXISTS daemon_outbox_pending_type_idx
          ON daemon_outbox(type, created_at, id)
          WHERE dead_lettered_at IS NULL`,
      ],
      pendingWhere: 'dead_lettered_at IS NULL',
    })
    this.ensureColumn('daemon_outbox', 'dead_lettered_at', 'TEXT')
    this.ensureColumn('daemon_outbox', 'dead_letter_reason', 'TEXT')
    this.deadLetterStmt = this.db.prepare(`
      UPDATE daemon_outbox
      SET last_error = ?,
          dead_lettered_at = ?,
          dead_letter_reason = ?
      WHERE id = ?
    `)
    this.pendingCountStmt = this.db.prepare('SELECT count(*) AS count FROM daemon_outbox WHERE dead_lettered_at IS NULL')
    this.deadLetterCountStmt = this.db.prepare('SELECT count(*) AS count FROM daemon_outbox WHERE dead_lettered_at IS NOT NULL')
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
    this.queue.insert({
      id: outboxId,
      type: message.type || '',
      payload,
      ignoreDuplicate: true,
    })
    return outboxId
  }

  pending(limit = 100) {
    return this.queue.pending([], limit).map(parseRow)
  }

  // Same order, minus the types the caller cannot currently send. See
  // SqliteTransportOutbox.pendingExcludingTypes for why this is not a filter
  // applied after the fetch.
  pendingExcludingTypes(types = [], limit = 100) {
    return this.queue.pendingExcludingTypes(types, [], limit).map(parseRow)
  }

  // The claim step: which rows are waiting, and of what type, without their
  // payloads. Pair with getWithSize() to read only what you are going to send.
  pendingRefs(limit = 100) {
    return this.queue.pendingRefs([], limit)
  }

  pendingRefsExcludingTypes(types = [], limit = 100) {
    return this.queue.pendingRefsExcludingTypes(types, [], limit)
  }

  pendingRefsOfTypes(types = [], limit = 100) {
    return this.queue.pendingRefsOfTypes(types, [], limit)
  }

  // get(), plus the payload's size on the wire, taken from the stored JSON
  // before it is parsed -- so a caller spending a byte budget bills itself for
  // what it actually sent rather than estimating.
  getWithSize(id) {
    const raw = this.queue.get(id)
    if (!raw) return null
    const parsed = parseRow(raw)
    if (!parsed) return null
    parsed.payloadBytes = raw.payload_json.length
    return parsed
  }

  markAttempt(id) {
    this.queue.markAttempt(id)
  }

  markError(id, error, { deadLetterEligible = true } = {}) {
    const message = this.queue.markError(id, error)
    const row = this.get(id)
    if (deadLetterEligible && row && row.attempts >= this.maxAttempts) {
      this.deadLetter(id, message)
      return { deadLettered: true, attempts: row.attempts, error: message }
    }
    return { deadLettered: false, attempts: row?.attempts || 0, error: message }
  }

  markTransientError(id, error) {
    const message = this.queue.markError(id, error)
    return { deadLettered: false, attempts: this.get(id)?.attempts || 0, error: message }
  }

  deadLetter(id, reason) {
    const message = String(reason?.message || reason || 'delivery failed')
    this.deadLetterStmt.run(message, this.clock(), message, id)
  }

  get(id) {
    return parseRow(this.queue.get(id))
  }

  ack(id) {
    this.queue.ack(id)
  }

  count() {
    return this.queue.count()
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

export function defaultOutboxPath(configDir, suffix = '') {
  return path.join(configDir, `daemon-outbox${suffix}.sqlite`)
}
