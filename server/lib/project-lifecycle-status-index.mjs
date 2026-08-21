import { join } from 'node:path'
import Database from 'better-sqlite3'

const UNKNOWN = Object.freeze({ status: 'unknown', phase: null, sourceRevision: null, acceptSeq: null })

function rowFor(project, status = UNKNOWN) {
  return {
    project,
    status: status?.status || 'unknown',
    phase: status?.phase || null,
    sourceRevision: status?.sourceRevision || null,
    acceptSeq: Number.isInteger(status?.acceptSeq) ? status.acceptSeq : null,
  }
}

export class ProjectLifecycleStatusIndex {
  constructor(projectsDir) {
    this.db = new Database(join(projectsDir, '..', 'data', 'project-files.sqlite'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_lifecycle_status (
        project TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        phase TEXT,
        source_revision TEXT,
        accept_seq INTEGER
      )
    `)
    this.upsertStatement = this.db.prepare(`
      INSERT INTO project_lifecycle_status (project, status, phase, source_revision, accept_seq)
      VALUES (@project, @status, @phase, @sourceRevision, @acceptSeq)
      ON CONFLICT(project) DO UPDATE SET
        status = excluded.status,
        phase = excluded.phase,
        source_revision = excluded.source_revision,
        accept_seq = excluded.accept_seq
    `)
    this.deleteStatement = this.db.prepare('DELETE FROM project_lifecycle_status WHERE project = ?')
    this.replaceAllTransaction = this.db.transaction(rows => {
      this.db.prepare('DELETE FROM project_lifecycle_status').run()
      for (const row of rows) this.upsertStatement.run(row)
    })
  }

  replaceAll(statuses) {
    this.replaceAllTransaction(statuses.map(({ project, status }) => rowFor(project, status)))
  }

  upsert(project, status) {
    this.upsertStatement.run(rowFor(project, status))
  }

  delete(project) {
    this.deleteStatement.run(project)
  }

  list() {
    return new Map(this.db.prepare(`
      SELECT project, status, phase, source_revision AS sourceRevision, accept_seq AS acceptSeq
      FROM project_lifecycle_status
    `).all().map(row => [row.project, row]))
  }

  close() {
    this.db.close()
  }
}

export { UNKNOWN as UNKNOWN_PROJECT_LIFECYCLE_STATUS }
