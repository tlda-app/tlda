// Server-authoritative roster playback for fleet daemons.  Unlike the delivery
// outbox, rows are never acknowledged or deleted during normal operation.
export class DaemonAgentEvents {
  constructor(db) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS daemon_agent_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, daemon_key TEXT NOT NULL,
      agent_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS daemon_agent_events_replay_idx ON daemon_agent_events(daemon_key, seq);`)
    this.latest = db.prepare('SELECT payload_json FROM daemon_agent_events WHERE daemon_key = ? AND agent_id = ? ORDER BY seq DESC LIMIT 1')
    this.insert = db.prepare('INSERT INTO daemon_agent_events (daemon_key, agent_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
    this.after = db.prepare('SELECT seq, payload_json FROM daemon_agent_events WHERE daemon_key = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    this.bounds = db.prepare('SELECT MIN(seq) AS first, MAX(seq) AS last FROM daemon_agent_events WHERE daemon_key = ?')
  }
  append(daemonKey, agent) {
    const payload = JSON.stringify({ type: 'agent-upsert', agent })
    const prior = this.latest.get(daemonKey, agent.id)?.payload_json
    if (prior === payload) return null
    return this.insert.run(daemonKey, agent.id, payload, new Date().toISOString()).lastInsertRowid
  }
  replay(daemonKey, lastSeq, limit = 1000) {
    const { first, last } = this.bounds.get(daemonKey)
    if (!Number.isInteger(lastSeq) || lastSeq < 0 || (first != null && lastSeq < first - 1)) return { snapshot: true, lastSeq: Number(last || 0), events: [] }
    const rows = this.after.all(daemonKey, lastSeq, limit)
    return { snapshot: false, lastSeq: Number(rows.at(-1)?.seq || lastSeq), events: rows.map(r => ({ seq: Number(r.seq), ...JSON.parse(r.payload_json) })) }
  }
}
