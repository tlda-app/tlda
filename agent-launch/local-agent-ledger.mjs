import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { newLocalAgentId } from './identity.mjs'

export function defaultLocalAgentLedgerPath() {
  const configDir = process.env.TLDA_DAEMON_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'tlda')
  return path.join(configDir, 'fleet-daemon.db')
}

function value(value) {
  return value == null || value === '' ? null : String(value)
}

function grantValue(grant) {
  return grant == null || grant === '' ? null : JSON.stringify(grant)
}

function parseGrant(value) {
  if (!value) return null
  return JSON.parse(value)
}

const LOCAL_RECIPE_SCHEMA_KEY = 'local-agent-process-recipes-schema'
const LOCAL_RECIPE_SCHEMA_CURRENT = 'permission-grant-v1'

function ensureLocalLedgerMetaTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_agent_ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function markLocalRecipeSchemaCurrent(db) {
  ensureLocalLedgerMetaTable(db)
  db.prepare(`
    INSERT INTO local_agent_ledger_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(LOCAL_RECIPE_SCHEMA_KEY, LOCAL_RECIPE_SCHEMA_CURRENT, new Date().toISOString())
}

function localRecipeSchemaIsCurrent(db) {
  ensureLocalLedgerMetaTable(db)
  const marked = db.prepare('SELECT value FROM local_agent_ledger_meta WHERE key = ?').get(LOCAL_RECIPE_SCHEMA_KEY)?.value
  if (marked === LOCAL_RECIPE_SCHEMA_CURRENT) return true
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_agent_process_recipes'").get()
  if (!table) return true
  try {
    db.prepare('SELECT local_agent_id, permission_grant FROM local_agent_process_recipes LIMIT 0').all()
    markLocalRecipeSchemaCurrent(db)
    return true
  } catch {
    return false
  }
}

function runHistoricalLocalRecipeMigration(dbPath) {
  const script = fileURLToPath(new URL('../migrations/permissions/local-agent-process-recipes-v1.mjs', import.meta.url))
  execFileSync(process.execPath, [script, dbPath], { stdio: 'inherit' })
}

export class LocalAgentLedger {
  constructor(file = defaultLocalAgentLedgerPath()) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new Database(file)
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    if (!localRecipeSchemaIsCurrent(this.db)) {
      this.db.close()
      runHistoricalLocalRecipeMigration(file)
      this.db = new Database(file)
      this.db.pragma('busy_timeout = 5000')
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = NORMAL')
      this.db.pragma('foreign_keys = ON')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_agents (
        local_agent_id TEXT PRIMARY KEY,
        server_agent_id TEXT UNIQUE,
        friendly_name TEXT,
        created_at TEXT NOT NULL,
        bound_at TEXT
      );
      CREATE TABLE IF NOT EXISTS local_agent_conversations (
        local_agent_id TEXT PRIMARY KEY REFERENCES local_agents(local_agent_id) ON DELETE CASCADE,
        session_id TEXT,
        harness TEXT,
        model TEXT
      );
      CREATE TABLE IF NOT EXISTS local_agent_process_recipes (
        local_agent_id TEXT PRIMARY KEY REFERENCES local_agents(local_agent_id) ON DELETE CASCADE,
        tmux_name TEXT,
        cwd TEXT,
        permission_grant TEXT
      );
      CREATE TABLE IF NOT EXISTS local_agent_mint_requests (
        request_id TEXT PRIMARY KEY,
        local_agent_id TEXT REFERENCES local_agents(local_agent_id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
        server_agent_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_agent_migration_issues (
        legacy_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_agents_server_agent_id
        ON local_agents(server_agent_id) WHERE server_agent_id IS NOT NULL;
    `)
    markLocalRecipeSchemaCurrent(this.db)
    this._getLocal = this.db.prepare('SELECT * FROM local_agents WHERE local_agent_id = ?')
    this._getServer = this.db.prepare('SELECT * FROM local_agents WHERE server_agent_id = ?')
    this._insertAgent = this.db.prepare(`
      INSERT INTO local_agents (local_agent_id, server_agent_id, friendly_name, created_at, bound_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    this._insertConversation = this.db.prepare(`
      INSERT INTO local_agent_conversations (local_agent_id, session_id, harness, model)
      VALUES (?, ?, ?, ?)
    `)
    this._insertRecipe = this.db.prepare(`
      INSERT INTO local_agent_process_recipes (local_agent_id, tmux_name, cwd, permission_grant)
      VALUES (?, ?, ?, ?)
    `)
    this._bind = this.db.prepare(`
      UPDATE local_agents
      SET server_agent_id = ?, bound_at = ?, friendly_name = COALESCE(?, friendly_name)
      WHERE local_agent_id = ? AND server_agent_id IS NULL
    `)
    this._create = this.db.transaction((row) => {
      this._insertAgent.run(row.localAgentId, row.serverAgentId, row.friendlyName, row.now, row.serverAgentId ? row.now : null)
      this._insertConversation.run(row.localAgentId, row.sessionId, row.harness, row.model)
      this._insertRecipe.run(row.localAgentId, row.tmuxName, row.cwd, row.permissionGrant)
      return this.get(row.localAgentId)
    })
  }

  get(identifier) {
    const key = value(identifier)
    if (!key) return null
    const agent = this._getLocal.get(key) || this._getServer.get(key)
    if (!agent) return null
    const conversation = this.db.prepare('SELECT * FROM local_agent_conversations WHERE local_agent_id = ?').get(agent.local_agent_id) || null
    const process = this.db.prepare('SELECT * FROM local_agent_process_recipes WHERE local_agent_id = ?').get(agent.local_agent_id) || null
    return {
      localAgentId: agent.local_agent_id,
      serverAgentId: agent.server_agent_id || null,
      friendlyName: agent.friendly_name || null,
      createdAt: agent.created_at,
      boundAt: agent.bound_at || null,
      conversation: conversation ? {
        sessionId: conversation.session_id || null,
        harness: conversation.harness || null,
        model: conversation.model || null,
      } : null,
      process: process ? {
        tmuxName: process.tmux_name || null,
        cwd: process.cwd || null,
        permissionGrant: parseGrant(process.permission_grant),
      } : null,
    }
  }

  findByFriendlyName(name) {
    const key = value(name)
    if (!key) return null
    const row = this.db.prepare(`
      SELECT local_agent_id FROM local_agents
      WHERE friendly_name = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(key)
    return row ? this.get(row.local_agent_id) : null
  }

  list() {
    return this.db.prepare(`
      SELECT local_agent_id FROM local_agents
      ORDER BY created_at DESC
    `).all().map(row => this.get(row.local_agent_id))
  }

  create({
    localAgentId = newLocalAgentId(),
    serverAgentId = null,
    friendlyName = null,
    sessionId = null,
    harness = null,
    model = null,
    tmuxName = null,
    cwd = null,
    permissionGrant = null,
    now = new Date().toISOString(),
  } = {}) {
    const existing = this.get(localAgentId)
    if (existing) {
      if (serverAgentId) this.bind(localAgentId, serverAgentId, { friendlyName, now })
      this.db.prepare(`
        UPDATE local_agents SET friendly_name = COALESCE(?, friendly_name)
        WHERE local_agent_id = ?
      `).run(value(friendlyName), existing.localAgentId)
      this.db.prepare(`
        INSERT INTO local_agent_conversations (local_agent_id, session_id, harness, model)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(local_agent_id) DO UPDATE SET
          session_id = COALESCE(excluded.session_id, session_id),
          harness = COALESCE(excluded.harness, harness),
          model = COALESCE(excluded.model, model)
      `).run(existing.localAgentId, value(sessionId), value(harness), value(model))
      this.db.prepare(`
        INSERT INTO local_agent_process_recipes (local_agent_id, tmux_name, cwd, permission_grant)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(local_agent_id) DO UPDATE SET
          tmux_name = COALESCE(excluded.tmux_name, tmux_name),
          cwd = COALESCE(excluded.cwd, cwd),
          permission_grant = COALESCE(excluded.permission_grant, permission_grant)
      `).run(existing.localAgentId, value(tmuxName), value(cwd), grantValue(permissionGrant))
      return this.get(localAgentId)
    }
    return this._create({
      localAgentId: value(localAgentId),
      serverAgentId: value(serverAgentId),
      friendlyName: value(friendlyName),
      sessionId: value(sessionId),
      harness: value(harness),
      model: value(model),
      tmuxName: value(tmuxName),
      cwd: value(cwd),
      permissionGrant: grantValue(permissionGrant),
      now,
    })
  }

  bind(localAgentId, serverAgentId, { friendlyName = null, now = new Date().toISOString() } = {}) {
    const localId = value(localAgentId)
    const serverId = value(serverAgentId)
    if (!localId || !serverId) throw new Error('identity binding requires local_agent_id and server_agent_id')
    const local = this.get(localId)
    if (!local) throw new Error(`cannot bind missing local agent ${localId}`)
    if (local.serverAgentId) {
      if (local.serverAgentId === serverId) return local
      throw new Error(`local agent ${localId} is already bound to ${local.serverAgentId}; refusing ${serverId}`)
    }
    const serverOwner = this.get(serverId)
    if (serverOwner && serverOwner.localAgentId !== localId) {
      throw new Error(`server agent ${serverId} is already bound to ${serverOwner.localAgentId}`)
    }
    try {
      const result = this._bind.run(serverId, now, value(friendlyName), localId)
      if (result.changes !== 1) throw new Error(`identity binding for ${localId} did not land`)
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE constraint failed')) {
        throw new Error(`server agent ${serverId} is already bound to another local agent`)
      }
      throw error
    }
    return this.get(localId)
  }

  updateConversation(localAgentId, { sessionId, harness, model } = {}) {
    const local = this.get(localAgentId)
    if (!local) throw new Error(`missing local agent ${localAgentId}`)
    this.db.prepare(`
      UPDATE local_agent_conversations SET
        session_id = COALESCE(?, session_id),
        harness = COALESCE(?, harness),
        model = COALESCE(?, model)
      WHERE local_agent_id = ?
    `).run(value(sessionId), value(harness), value(model), local.localAgentId)
    return this.get(local.localAgentId)
  }

  updateProcess(localAgentId, { tmuxName, cwd, permissionGrant } = {}) {
    const local = this.get(localAgentId)
    if (!local) throw new Error(`missing local agent ${localAgentId}`)
    this.db.prepare(`
      UPDATE local_agent_process_recipes SET
        tmux_name = COALESCE(?, tmux_name),
        cwd = COALESCE(?, cwd),
        permission_grant = COALESCE(?, permission_grant)
      WHERE local_agent_id = ?
    `).run(value(tmuxName), value(cwd), grantValue(permissionGrant), local.localAgentId)
    return this.get(local.localAgentId)
  }

  delete(localAgentId) {
    const local = this.get(localAgentId)
    if (!local) return false
    return this.db.prepare('DELETE FROM local_agents WHERE local_agent_id = ?').run(local.localAgentId).changes === 1
  }

  close() {
    this.db.close()
  }
}

export function createLocalAgentLedger(file) {
  return new LocalAgentLedger(file)
}
