import { randomUUID } from 'node:crypto'

function nowIso() {
  return new Date().toISOString()
}

function parseJson(value, fallback) {
  if (!value) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function parseRow(row) {
  if (!row) return null
  return {
    operationId: row.operation_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    type: row.type,
    mode: row.mode,
    params: parseJson(row.params_json, {}),
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
    result: parseJson(row.result_json, null),
  }
}

export function isRetryableTransportError(error) {
  const msg = String(error?.message || error || '')
  return /WS connection closed|idle timeout|deadline exceeded|request timeout|timed out|not connected|ECONNRESET|ECONNREFUSED|EPIPE/i.test(msg)
}

export class FleetTransportOutbox {
  constructor(db, {
    clock = nowIso,
    maxAttempts = 8,
    baseRetryMs = 1000,
    maxRetryMs = 60_000,
  } = {}) {
    if (!db) throw new Error('FleetTransportOutbox requires db')
    this.db = db
    this.clock = clock
    this.maxAttempts = maxAttempts
    this.baseRetryMs = baseRetryMs
    this.maxRetryMs = maxRetryMs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_fleet_outbox (
        operation_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        type TEXT NOT NULL,
        mode TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_attempt_at TEXT,
        last_attempt_at TEXT,
        last_error TEXT,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS mcp_fleet_outbox_due_idx
        ON mcp_fleet_outbox(agent_id, session_id, status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS mcp_fleet_outbox_status_idx
        ON mcp_fleet_outbox(status, updated_at);
    `)
    this.insertStmt = this.db.prepare(`
      INSERT INTO mcp_fleet_outbox
        (operation_id, agent_id, session_id, type, mode, params_json, status, attempts, created_at, updated_at, next_attempt_at)
      VALUES
        (@operation_id, @agent_id, @session_id, @type, @mode, @params_json, 'pending', 0, @now, @now, @now)
      ON CONFLICT(operation_id) DO NOTHING
    `)
    this.getStmt = this.db.prepare('SELECT * FROM mcp_fleet_outbox WHERE operation_id = ?')
    this.pendingExactStmt = this.db.prepare(`
      SELECT * FROM mcp_fleet_outbox
      WHERE operation_id = ?
        AND agent_id = ?
        AND status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      LIMIT 1
    `)
    this.pendingDueStmt = this.db.prepare(`
      SELECT * FROM mcp_fleet_outbox
      WHERE agent_id = ?
        AND status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC, operation_id ASC
      LIMIT ?
    `)
    this.markAttemptStmt = this.db.prepare(`
      UPDATE mcp_fleet_outbox
      SET attempts = attempts + 1,
          status = 'inflight',
          last_attempt_at = ?,
          updated_at = ?,
          last_error = NULL
      WHERE operation_id = ?
    `)
    this.markAcceptedStmt = this.db.prepare(`
      UPDATE mcp_fleet_outbox
      SET status = 'accepted',
          result_json = ?,
          updated_at = ?,
          next_attempt_at = NULL,
          last_error = NULL
      WHERE operation_id = ?
    `)
    this.markRetryStmt = this.db.prepare(`
      UPDATE mcp_fleet_outbox
      SET status = 'retrying',
          last_error = ?,
          next_attempt_at = ?,
          updated_at = ?
      WHERE operation_id = ?
    `)
    this.markFailedStmt = this.db.prepare(`
      UPDATE mcp_fleet_outbox
      SET status = ?,
          last_error = ?,
          next_attempt_at = NULL,
          updated_at = ?
      WHERE operation_id = ?
    `)
    this.recoverInflightStmt = this.db.prepare(`
      UPDATE mcp_fleet_outbox
      SET status = 'retrying',
          last_error = ?,
          next_attempt_at = ?,
          updated_at = ?
      WHERE agent_id = ?
        AND status = 'inflight'
    `)
    this.countStatusStmt = this.db.prepare('SELECT count(*) AS count FROM mcp_fleet_outbox WHERE status = ?')
  }

  enqueue({ operationId = null, agentId, sessionId = null, type, params, mode = 'durable' }) {
    if (!agentId) throw new Error('fleet transport enqueue requires agentId')
    if (!type) throw new Error('fleet transport enqueue requires type')
    const id = operationId || params?._tempId || `${agentId}:mcp-${type}:${randomUUID()}`
    const now = this.clock()
    this.insertStmt.run({
      operation_id: id,
      agent_id: agentId,
      session_id: sessionId || null,
      type,
      mode,
      params_json: JSON.stringify(params || {}),
      now,
    })
    return parseRow(this.getStmt.get(id))
  }

  get(operationId) {
    return parseRow(this.getStmt.get(operationId))
  }

  dueRows({ agentId, sessionId = null, operationId = null, limit = 50 } = {}) {
    if (!agentId) return []
    const now = this.clock()
    if (operationId) {
      const row = this.pendingExactStmt.get(operationId, agentId, now)
      return row ? [parseRow(row)] : []
    }
    return this.pendingDueStmt.all(agentId, now, limit).map(parseRow)
  }

  markAttempt(operationId) {
    const now = this.clock()
    this.markAttemptStmt.run(now, now, operationId)
    return this.get(operationId)
  }

  markAccepted(operationId, result) {
    this.markAcceptedStmt.run(JSON.stringify(result || {}), this.clock(), operationId)
    return this.get(operationId)
  }

  markFailure(operationId, error, { retryable = false } = {}) {
    const row = this.get(operationId)
    if (!row) return null
    const message = String(error?.message || error || 'send failed')
    if (!retryable || row.attempts >= this.maxAttempts) {
      const status = retryable ? 'dead' : 'failed'
      this.markFailedStmt.run(status, message, this.clock(), operationId)
      return this.get(operationId)
    }
    const delayMs = Math.min(this.maxRetryMs, this.baseRetryMs * Math.pow(2, Math.max(0, row.attempts - 1)))
    const next = new Date(Date.now() + delayMs).toISOString()
    this.markRetryStmt.run(message, next, this.clock(), operationId)
    return this.get(operationId)
  }

  recoverInflight({ agentId, reason = 'MCP process restarted before transport ACK' } = {}) {
    if (!agentId) return 0
    const now = this.clock()
    return this.recoverInflightStmt.run(reason, now, now, agentId).changes
  }

  countByStatus(status) {
    return this.countStatusStmt.get(status).count
  }
}
