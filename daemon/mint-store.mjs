import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export class MintFactConflictError extends Error {
  constructor(mintId, fact, current, incoming) {
    super(`mint ${mintId} already has a different ${fact}`)
    this.name = 'MintFactConflictError'
    this.code = 'mint-fact-conflict'
    this.fact = fact
    this.current = current
    this.incoming = incoming
  }
}
const COLUMNS = new Set([
  'fleet_id',
  'friendly_name',
  'metadata',
  'launch_recipe',
  'process_state',
  'session_id',
  'session_path',
])

function encoded(value) {
  return value == null ? null : (typeof value === 'string' ? value : JSON.stringify(value))
}

function decoded(value) {
  if (value == null) return null
  try { return JSON.parse(value) } catch { return value }
}

function mintRow(row) {
  return row ? {
    mintId: row.mint_id,
    fleetId: row.fleet_id,
    friendlyName: row.friendly_name,
    metadata: decoded(row.metadata),
    launchRecipe: decoded(row.launch_recipe),
    processState: decoded(row.process_state),
    sessionId: row.session_id,
    sessionPath: row.session_path,
    joinedAt: row.joined_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null
}

export function readMintFacts(file, mintId) {
  if (!file || !mintId || !fs.existsSync(file)) return null
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daemon_mints'").get()
    if (!table) return null
    return mintRow(db.prepare('SELECT * FROM daemon_mints WHERE mint_id = ?').get(mintId))
  } finally {
    db.close()
  }
}

export function resolveLoginFleetId({ explicitFleetId = null, mintId = null, storeFile = null } = {}) {
  return explicitFleetId || readMintFacts(storeFile, mintId)?.fleetId || null
}

export class MintStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file)
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_mints (
        mint_id TEXT PRIMARY KEY,
        fleet_id TEXT UNIQUE,
        friendly_name TEXT,
        metadata TEXT,
        launch_recipe TEXT,
        process_state TEXT,
        session_id TEXT,
        session_path TEXT,
        joined_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  ensure(mintId, now = new Date().toISOString()) {
    if (!mintId) throw new Error('mint_id is required')
    this.db.prepare(`
      INSERT INTO daemon_mints (mint_id, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(mint_id) DO NOTHING
    `).run(mintId, now, now)
    return this.get(mintId)
  }

  get(mintId) {
    const row = this.db.prepare('SELECT * FROM daemon_mints WHERE mint_id = ?').get(mintId)
    return mintRow(row)
  }

  getByFleetId(fleetId) {
    const row = this.db.prepare('SELECT * FROM daemon_mints WHERE fleet_id = ?').get(fleetId)
    return mintRow(row)
  }

  getByFriendlyName(name) {
    const row = this.db.prepare(`
      SELECT * FROM daemon_mints WHERE friendly_name = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(name)
    return mintRow(row)
  }

  resolve(identifier) {
    if (!identifier) return null
    return this.get(identifier)
      || this.getByFleetId(identifier)
      || this.getByFriendlyName(identifier)
  }

  updateProcessState(mintId, processState, now = new Date().toISOString()) {
    const incoming = encoded(processState)
    if (!mintId || incoming == null) throw new Error('mint_id and process_state are required')
    const result = this.db.prepare(`
      UPDATE daemon_mints
      SET process_state = ?, updated_at = ?
      WHERE mint_id = ?
    `).run(incoming, now, mintId)
    if (result.changes !== 1) throw new Error(`no daemon mint facts for ${mintId}`)
    return this.get(mintId)
  }

  setFact(mintId, fact, value, now = new Date().toISOString()) {
    if (!COLUMNS.has(fact)) throw new Error(`unknown mint fact: ${fact}`)
    const incoming = encoded(value)
    if (incoming == null) return this.ensure(mintId, now)
    const update = this.db.transaction(() => {
      this.ensure(mintId, now)
      const current = this.db.prepare(`SELECT ${fact} AS value FROM daemon_mints WHERE mint_id = ?`).get(mintId)?.value ?? null
      if (current != null && current !== incoming) {
        throw new MintFactConflictError(mintId, fact, decoded(current), value)
      }
      if (current == null) {
        this.db.prepare(`UPDATE daemon_mints SET ${fact} = ?, updated_at = ? WHERE mint_id = ?`).run(incoming, now, mintId)
      }
      return this.get(mintId)
    })
    return update()
  }

  markJoined(mintId, now = new Date().toISOString()) {
    this.ensure(mintId, now)
    this.db.prepare(`
      UPDATE daemon_mints SET joined_at = COALESCE(joined_at, ?), updated_at = ?
      WHERE mint_id = ?
    `).run(now, now, mintId)
    return this.get(mintId)
  }

  close() {
    this.db.close()
  }
}
