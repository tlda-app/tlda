function nowIso() {
  return new Date().toISOString()
}

function validateSqlIdentifier(name, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label} must be a simple SQL identifier`)
  }
  return name
}

function validateSqlFragment(fragment, label) {
  if (/[;]/.test(fragment)) throw new Error(`${label} must not contain statement separators`)
  return fragment
}

export function parseTransportOutboxRow(row) {
  if (!row) return null
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    attempts: row.attempts,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
  }
}

export class SqliteTransportOutbox {
  constructor(db, {
    tableName,
    clock = nowIso,
    extraColumns = [],
    indexes = [],
    pendingWhere = '1 = 1',
    pendingOrder = 'created_at ASC, id ASC',
  } = {}) {
    if (!db) throw new Error('SqliteTransportOutbox requires db')
    this.db = db
    this.clock = clock
    this.tableName = validateSqlIdentifier(tableName, 'tableName')
    this.pendingWhere = validateSqlFragment(pendingWhere, 'pendingWhere')
    this.pendingOrder = validateSqlFragment(pendingOrder, 'pendingOrder')
    this.extraColumns = extraColumns.map(col => ({
      name: validateSqlIdentifier(col.name, 'extra column name'),
      definition: validateSqlFragment(col.definition, `definition for ${col.name}`),
    }))

    const commonColumns = [
      'id TEXT PRIMARY KEY',
      'type TEXT NOT NULL',
      'payload_json TEXT NOT NULL',
      'attempts INTEGER NOT NULL DEFAULT 0',
      'created_at TEXT NOT NULL',
      'last_attempt_at TEXT',
      'last_error TEXT',
    ]
    const extraColumnSql = this.extraColumns.map(col => `${col.name} ${col.definition}`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        ${[...commonColumns, ...extraColumnSql].join(',\n        ')}
      );
      ${indexes.map(indexSql => `${validateSqlFragment(indexSql, 'index SQL')};`).join('\n')}
    `)

    const insertColumns = [
      'id',
      ...this.extraColumns.map(col => col.name),
      'type',
      'payload_json',
      'attempts',
      'created_at',
      'last_attempt_at',
      'last_error',
    ]
    const insertValues = [
      '@id',
      ...this.extraColumns.map(col => `@${col.name}`),
      '@type',
      '@payload_json',
      '0',
      '@created_at',
      'NULL',
      'NULL',
    ]
    this.insertStmt = this.db.prepare(`
      INSERT INTO ${this.tableName}
        (${insertColumns.join(', ')})
      VALUES
        (${insertValues.join(', ')})
    `)
    this.insertOrIgnoreStmt = this.db.prepare(`
      INSERT OR IGNORE INTO ${this.tableName}
        (${insertColumns.join(', ')})
      VALUES
        (${insertValues.join(', ')})
    `)
    this.pendingStmt = this.db.prepare(`
      SELECT * FROM ${this.tableName}
      WHERE ${this.pendingWhere}
      ORDER BY ${this.pendingOrder}
      LIMIT ?
    `)
    this.ackStmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`)
    this.markAttemptStmt = this.db.prepare(`
      UPDATE ${this.tableName}
      SET attempts = attempts + 1,
          last_attempt_at = ?,
          last_error = NULL
      WHERE id = ?
    `)
    this.markErrorStmt = this.db.prepare(`
      UPDATE ${this.tableName}
      SET last_error = ?
      WHERE id = ?
    `)
    this.getStmt = this.db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`)
    this.countStmt = this.db.prepare(`SELECT count(*) AS count FROM ${this.tableName}`)
  }

  prepare(sql) {
    return this.db.prepare(sql)
  }

  transaction(fn) {
    return this.db.transaction(fn)
  }

  insert({ id, type, payload, extra = {}, createdAt = this.clock(), ignoreDuplicate = false }) {
    const row = {
      id,
      type: type || '',
      payload_json: JSON.stringify(payload),
      created_at: createdAt,
    }
    for (const col of this.extraColumns) row[col.name] = extra[col.name] ?? null
    const stmt = ignoreDuplicate ? this.insertOrIgnoreStmt : this.insertStmt
    return stmt.run(row)
  }

  pending(params = [], limit = 100) {
    return this.pendingStmt.all(...params, limit)
  }

  markAttempt(id) {
    this.markAttemptStmt.run(this.clock(), id)
  }

  markError(id, error) {
    const message = String(error?.message || error || 'send failed')
    this.markErrorStmt.run(message, id)
    return message
  }

  ack(id) {
    this.ackStmt.run(id)
  }

  get(id) {
    return this.getStmt.get(id)
  }

  count() {
    return this.countStmt.get().count
  }
}
