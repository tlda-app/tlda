import Database from 'better-sqlite3'

export class BuildQueueStore {
  constructor(path = ':memory:') {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS build_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        revision TEXT NOT NULL,
        daemon_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'build',
        integer_priority INTEGER NOT NULL,
        fractional_priority REAL NOT NULL,
        priority REAL NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','running','complete','failed','killed')),
        started_once INTEGER NOT NULL DEFAULT 0,
        terminal_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project, revision)
      );
      CREATE INDEX IF NOT EXISTS build_submissions_state_priority
        ON build_submissions(state, priority DESC, id ASC);
      CREATE TABLE IF NOT EXISTS build_ring (
        daemon_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL
      );
    `)
    // A running process did not survive this process. Its immutable proposal
    // did, so the same keyed record becomes schedulable without a second
    // priority draw. `started_once` prevents recovery from rotating twice.
    this.db.prepare("UPDATE build_submissions SET state = 'pending', updated_at = ? WHERE state = 'running'")
      .run(new Date().toISOString())
  }

  close() { this.db.close() }

  get(project, revision) {
    return this.db.prepare('SELECT * FROM build_submissions WHERE project = ? AND revision = ?').get(project, revision) || null
  }

  list(state = null, project = null) {
    if (state && project) return this.db.prepare('SELECT * FROM build_submissions WHERE state = ? AND project = ? ORDER BY priority DESC, id').all(state, project)
    if (state) return this.db.prepare('SELECT * FROM build_submissions WHERE state = ? ORDER BY priority DESC, id').all(state)
    if (project) return this.db.prepare('SELECT * FROM build_submissions WHERE project = ? ORDER BY id').all(project)
    return this.db.prepare('SELECT * FROM build_submissions ORDER BY id').all()
  }

  removeProject(project) {
    return this.db.transaction(() => {
      const daemonIds = this.db.prepare('SELECT DISTINCT daemon_id FROM build_submissions WHERE project = ?')
        .all(project).map(row => row.daemon_id)
      const removed = this.db.prepare('DELETE FROM build_submissions WHERE project = ?').run(project).changes
      const removeUnusedRingEntry = this.db.prepare(`
        DELETE FROM build_ring
        WHERE daemon_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM build_submissions
            WHERE daemon_id = ? AND state IN ('pending','running')
          )
      `)
      for (const daemonId of daemonIds) removeUnusedRingEntry.run(daemonId, daemonId)
      return removed
    })()
  }

  ring() {
    return new Map(this.db.prepare('SELECT daemon_id, position FROM build_ring ORDER BY position DESC').all()
      .map(row => [row.daemon_id, row.position]))
  }

  #ensureRingPosition(daemonId) {
    const held = this.db.prepare('SELECT position FROM build_ring WHERE daemon_id = ?').get(daemonId)
    if (held) return held.position
    const back = this.db.prepare('SELECT MIN(position) AS position FROM build_ring').get().position
    const position = back == null ? 0 : back - 1
    this.db.prepare('INSERT INTO build_ring(daemon_id, position) VALUES (?, ?)').run(daemonId, position)
    return position
  }

  admit({ project, revision, daemonId, branch, kind = 'build', fractionalPriority, state = 'pending', reason = null }) {
    return this.db.transaction(() => {
      const existing = this.get(project, revision)
      if (existing) return { row: existing, inserted: false }
      const integerPriority = this.#ensureRingPosition(daemonId)
      const now = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO build_submissions(
          project, revision, daemon_id, branch, kind,
          integer_priority, fractional_priority, priority,
          state, terminal_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project, revision, daemonId, branch, kind,
        integerPriority, fractionalPriority, integerPriority + fractionalPriority,
        state, reason, now, now,
      )
      return { row: this.get(project, revision), inserted: true }
    })()
  }

  start(id) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM build_submissions WHERE id = ?').get(id)
      if (!row || row.state !== 'pending') return null
      if (!row.started_once) {
        const otherBack = this.db.prepare('SELECT MIN(position) AS position FROM build_ring WHERE daemon_id <> ?').get(row.daemon_id).position
        this.db.prepare('UPDATE build_ring SET position = ? WHERE daemon_id = ?')
          .run(otherBack == null ? 0 : otherBack - 1, row.daemon_id)
      }
      const now = new Date().toISOString()
      this.db.prepare("UPDATE build_submissions SET state = 'running', started_once = 1, updated_at = ? WHERE id = ?")
        .run(now, id)
      return this.db.prepare('SELECT * FROM build_submissions WHERE id = ?').get(id)
    })()
  }

  settle(id, state, reason = null) {
    if (!['complete', 'failed', 'killed'].includes(state)) throw new Error(`invalid terminal build state: ${state}`)
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM build_submissions WHERE id = ?').get(id)
      if (!row || ['complete', 'failed', 'killed'].includes(row.state)) return row || null
      this.db.prepare('UPDATE build_submissions SET state = ?, terminal_reason = ?, updated_at = ? WHERE id = ?')
        .run(state, reason, new Date().toISOString(), id)
      const active = this.db.prepare("SELECT 1 FROM build_submissions WHERE daemon_id = ? AND state IN ('pending','running') LIMIT 1").get(row.daemon_id)
      if (!active) this.db.prepare('DELETE FROM build_ring WHERE daemon_id = ?').run(row.daemon_id)
      return this.db.prepare('SELECT * FROM build_submissions WHERE id = ?').get(id)
    })()
  }
}
