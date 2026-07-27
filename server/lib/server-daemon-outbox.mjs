import { randomUUID } from 'crypto'
import { SERVER_DAEMON_OUTBOX_ID_FIELD } from '../../shared/daemon-delivery.mjs'
import { SqliteTransportOutbox, parseTransportOutboxRow } from '../../shared/fleet-transport.mjs'

function nowIso() {
  return new Date().toISOString()
}

function parseRow(row) {
  const parsed = parseTransportOutboxRow(row)
  if (!parsed) return null
  return {
    ...parsed,
    daemonKey: row.daemon_key,
    dedupeKey: row.dedupe_key,
  }
}

export class ServerDaemonOutbox {
  constructor(db, { clock = nowIso } = {}) {
    if (!db) throw new Error('ServerDaemonOutbox requires db')
    this.db = db
    this.clock = clock
    this.queue = new SqliteTransportOutbox(this.db, {
      tableName: 'server_daemon_outbox',
      clock,
      extraColumns: [
        { name: 'daemon_key', definition: 'TEXT NOT NULL' },
        { name: 'dedupe_key', definition: 'TEXT' },
      ],
      indexes: [
        `CREATE INDEX IF NOT EXISTS server_daemon_outbox_pending_idx
          ON server_daemon_outbox(daemon_key, created_at, id)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS server_daemon_outbox_dedupe_idx
          ON server_daemon_outbox(daemon_key, dedupe_key)
          WHERE dedupe_key IS NOT NULL`,
      ],
      pendingWhere: 'daemon_key = ?',
    })
    this.deleteDedupeStmt = this.db.prepare(`
      DELETE FROM server_daemon_outbox
      WHERE daemon_key = ? AND dedupe_key = ?
    `)
    this.enqueueTxn = this.db.transaction(({ id, daemonKey, dedupeKey, type, payload, createdAt }) => {
      if (dedupeKey) this.deleteDedupeStmt.run(daemonKey, dedupeKey)
      this.queue.insert({
        id,
        type,
        payload,
        createdAt,
        extra: {
          daemon_key: daemonKey,
          dedupe_key: dedupeKey || null,
        },
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
    return this.queue.pending([daemonKey], limit).map(parseRow)
  }

  markAttempt(id) {
    this.queue.markAttempt(id)
  }

  markError(id, error) {
    this.queue.markError(id, error)
  }

  get(id) {
    return parseRow(this.queue.get(id))
  }

  ack(id) {
    this.queue.ack(id)
  }

  deleteByDedupeKey(daemonKey, dedupeKey) {
    if (!daemonKey || !dedupeKey) return 0
    return this.deleteDedupeStmt.run(daemonKey, dedupeKey).changes
  }
}
