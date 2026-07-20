import { randomUUID } from 'crypto'

export class AgentSeatBindingObligations {
  constructor(db, { clock = () => new Date().toISOString() } = {}) {
    if (!db) throw new Error('AgentSeatBindingObligations requires db')
    this.db = db
    this.clock = clock
    const existingCols = db.prepare("PRAGMA table_info(agent_seat_binding_obligations)").all()
    if (existingCols.some(col => col.name === 'tmux_session')) {
      db.exec('DROP TABLE agent_seat_binding_obligations')
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_seat_binding_obligations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        daemon_key TEXT NOT NULL,
        local_agent_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, local_agent_id)
      );
      CREATE INDEX IF NOT EXISTS agent_seat_binding_obligations_daemon_idx
        ON agent_seat_binding_obligations(daemon_key, created_at, id);
    `)
    this.upsertStmt = db.prepare(`
      INSERT INTO agent_seat_binding_obligations
        (id, agent_id, daemon_key, local_agent_id, payload_json, created_at, updated_at)
      VALUES (@id, @agent_id, @daemon_key, @local_agent_id, @payload_json, @created_at, @updated_at)
      ON CONFLICT(agent_id, local_agent_id) DO UPDATE SET
        daemon_key = excluded.daemon_key,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      RETURNING *
    `)
    this.getStmt = db.prepare('SELECT * FROM agent_seat_binding_obligations WHERE id = ?')
    this.listStmt = db.prepare('SELECT * FROM agent_seat_binding_obligations WHERE daemon_key = ? ORDER BY created_at, id')
    this.deleteStmt = db.prepare('DELETE FROM agent_seat_binding_obligations WHERE id = ?')
  }

  put(payload) {
    const now = this.clock()
    const row = this.upsertStmt.get({
      id: payload.obligation_id || randomUUID(),
      agent_id: payload.agent_id,
      daemon_key: payload.daemon_key,
      local_agent_id: payload.local_agent_id,
      payload_json: JSON.stringify(payload),
      created_at: now,
      updated_at: now,
    })
    return this.parse(row)
  }

  get(id) { return this.parse(this.getStmt.get(id)) }
  listForDaemon(daemonKey) { return this.listStmt.all(daemonKey).map(row => this.parse(row)) }
  remove(id) { return this.deleteStmt.run(id).changes > 0 }

  parse(row) {
    if (!row) return null
    return { ...JSON.parse(row.payload_json), obligation_id: row.id, created_at: row.created_at, updated_at: row.updated_at }
  }
}

export function verifyAgentSeatBindingTerminal({ obligation, message, daemonKey, agent, seat } = {}) {
  if (
    !obligation ||
    message?.agent_id !== obligation.agent_id ||
    message?.daemon_key !== obligation.daemon_key ||
    daemonKey !== obligation.daemon_key
  ) throw new Error(`binding obligation terminal identity mismatch for ${obligation?.obligation_id || 'unknown'}`)
  if (agent?.dead !== 1 || seat) {
    throw new Error(`binding obligation terminal retirement is not verified for ${obligation.agent_id}`)
  }
  return true
}
