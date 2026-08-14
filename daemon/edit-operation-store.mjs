import Database from 'better-sqlite3'

export class EditOperationStore {
  constructor(dbPath, { clock = () => Date.now() } = {}) {
    this.db = new Database(dbPath)
    this.clock = clock
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edit_operations (
        operation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, absolute_path TEXT NOT NULL,
        operation_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', observed_at_ms INTEGER NOT NULL,
        disposition_key TEXT, disposition_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS edit_operations_pending_path
        ON edit_operations(absolute_path, observed_at_ms) WHERE state = 'pending';
      CREATE TABLE IF NOT EXISTS source_change_dispositions (
        outbox_id TEXT PRIMARY KEY, kind TEXT NOT NULL, operation_ids_json TEXT NOT NULL,
        retry_outbox_id TEXT, retry_request_id TEXT, retry_fingerprint TEXT, retry_payload_json TEXT,
        retry_enqueued INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL
      );
    `)
    this.insertOperation = this.db.prepare(`INSERT OR IGNORE INTO edit_operations
      (operation_id,agent_id,absolute_path,operation_json,state,observed_at_ms) VALUES (?,?,?,?, 'pending',?)`)
    this.pendingPath = this.db.prepare(`SELECT * FROM edit_operations WHERE absolute_path=? AND state='pending' AND observed_at_ms>=? ORDER BY observed_at_ms,operation_id`)
    this.setState = this.db.prepare(`UPDATE edit_operations SET state=?,disposition_key=?,disposition_reason=? WHERE operation_id=? AND state='pending'`)
    this.getDispositionStmt = this.db.prepare('SELECT * FROM source_change_dispositions WHERE outbox_id=?')
    this.insertDisposition = this.db.prepare(`INSERT OR IGNORE INTO source_change_dispositions
      (outbox_id,kind,operation_ids_json,retry_outbox_id,retry_request_id,retry_fingerprint,retry_payload_json,retry_enqueued,created_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    this.markRetryStmt = this.db.prepare('UPDATE source_change_dispositions SET retry_enqueued=1 WHERE outbox_id=?')
  }
  record(agentId, absolutePath, operation) {
    if (!operation?.operation_id) return false
    return this.insertOperation.run(operation.operation_id, agentId, absolutePath, JSON.stringify(operation), this.clock()).changes > 0
  }
  pendingForPaths(paths, { sinceMs = 0 } = {}) {
    const found = new Map()
    for (const path of paths) for (const row of this.pendingPath.all(path, sinceMs)) found.set(row.operation_id, row)
    return [...found.values()].sort((a,b) => a.observed_at_ms-b.observed_at_ms || a.operation_id.localeCompare(b.operation_id)).map(row => ({
      agentId: row.agent_id, operation: JSON.parse(row.operation_json), ts: row.observed_at_ms,
    }))
  }
  disposition(outboxId) {
    const row = this.getDispositionStmt.get(outboxId)
    return row ? { ...row, operationIds: JSON.parse(row.operation_ids_json), retryPayload: row.retry_payload_json ? JSON.parse(row.retry_payload_json) : null } : null
  }
  applyDisposition({ outboxId, kind, operationIds, reason = null, retry = null }) {
    const existing = this.disposition(outboxId)
    if (existing) return existing
    const transition = this.db.transaction(() => {
      this.insertDisposition.run(outboxId, kind, JSON.stringify(operationIds), retry?.outboxId || null, retry?.requestId || null, retry?.fingerprint || null, retry ? JSON.stringify(retry.payload) : null, 0, this.clock())
      const state = kind === 'accepted' ? 'accepted' : kind === 'retry_pending' ? null : kind === 'quarantined' ? 'quarantined' : 'retired'
      if (state) for (const id of operationIds) this.setState.run(state, outboxId, reason || kind, id)
    })
    transition()
    return this.disposition(outboxId)
  }
  markRetryEnqueued(outboxId) { this.markRetryStmt.run(outboxId) }
  pendingRetries() { return this.db.prepare("SELECT outbox_id FROM source_change_dispositions WHERE kind='retry_pending' AND retry_enqueued=0").all().map(row => this.disposition(row.outbox_id)) }
  state(operationId) { return this.db.prepare('SELECT state,disposition_key,disposition_reason FROM edit_operations WHERE operation_id=?').get(operationId) || null }
  close() { this.db.close() }
}
