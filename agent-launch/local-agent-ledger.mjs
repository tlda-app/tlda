import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

function migratedLegacyPermissionProfile(name) {
  const key = String(name || '').trim()
  if (!key) return null
  if (['wd', 'math', 'app-dev', 'ops'].includes(key)) return key
  if (['cwd', 'write', 'read', 'none'].includes(key)) return 'wd'
  if (['unsandboxed', 'full', 'break-glass'].includes(key)) return 'ops'
  return key
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
        permission_profile TEXT
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
      INSERT INTO local_agent_process_recipes (local_agent_id, tmux_name, cwd, permission_profile)
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
      this._insertRecipe.run(row.localAgentId, row.tmuxName, row.cwd, row.permissionProfile)
      return this.get(row.localAgentId)
    })
    this.backfillLegacyPermissionGrants()
  }

  backfillLegacyPermissionGrants({ now = new Date().toISOString() } = {}) {
    const hasLegacy = this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'permission_grants'
    `).get()
    if (!hasLegacy) return { imported: 0, quarantined: 0 }
    const columns = new Set(this.db.prepare('PRAGMA table_info(permission_grants)').all().map(row => row.name))
    const legacyColumn = (name) => columns.has(name) ? name : `NULL AS ${name}`
    const rows = this.db.prepare(`
      SELECT id, ${legacyColumn('friendly_name')}, ${legacyColumn('session_id')},
             ${legacyColumn('session_kind')}, ${legacyColumn('tmux_session')},
             ${legacyColumn('model')}, ${legacyColumn('cwd')}, ${legacyColumn('spawn_policy')}
      FROM permission_grants
    `).all()
    let imported = 0
    let quarantined = 0
    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        if (!row.id || !String(row.id).startsWith('fleet:')) {
          this.db.prepare(`
            INSERT INTO local_agent_migration_issues (legacy_id, reason, observed_at)
            VALUES (?, ?, ?)
            ON CONFLICT(legacy_id) DO UPDATE SET reason = excluded.reason, observed_at = excluded.observed_at
          `).run(String(row.id || '(missing)'), 'legacy permission row has no unambiguous server agent id', now)
          quarantined++
          continue
        }
        if (this._getServer.get(row.id)) continue
        let permissionProfile = null
        try {
          permissionProfile = migratedLegacyPermissionProfile(JSON.parse(row.spawn_policy || 'null')?.name)
        } catch (error) {
          this.db.prepare(`
            INSERT INTO local_agent_migration_issues (legacy_id, reason, observed_at)
            VALUES (?, ?, ?)
            ON CONFLICT(legacy_id) DO UPDATE SET reason = excluded.reason, observed_at = excluded.observed_at
          `).run(String(row.id), `legacy spawn_policy is invalid JSON: ${error.message}`, now)
          quarantined++
          continue
        }
        this._create({
          localAgentId: newLocalAgentId(),
          serverAgentId: row.id,
          friendlyName: row.friendly_name || null,
          sessionId: row.session_id || null,
          harness: row.session_kind || null,
          model: row.model || null,
          tmuxName: row.tmux_session || null,
          cwd: row.cwd || null,
          permissionProfile,
          now,
        })
        imported++
      }
    })
    migrate()
    return { imported, quarantined }
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
        permissionProfile: process.permission_profile || null,
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

  create({
    localAgentId = newLocalAgentId(),
    serverAgentId = null,
    friendlyName = null,
    sessionId = null,
    harness = null,
    model = null,
    tmuxName = null,
    cwd = null,
    permissionProfile = null,
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
        INSERT INTO local_agent_process_recipes (local_agent_id, tmux_name, cwd, permission_profile)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(local_agent_id) DO UPDATE SET
          tmux_name = COALESCE(excluded.tmux_name, tmux_name),
          cwd = COALESCE(excluded.cwd, cwd),
          permission_profile = COALESCE(excluded.permission_profile, permission_profile)
      `).run(existing.localAgentId, value(tmuxName), value(cwd), value(permissionProfile))
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
      permissionProfile: value(permissionProfile),
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

  updateProcess(localAgentId, { tmuxName, cwd, permissionProfile } = {}) {
    const local = this.get(localAgentId)
    if (!local) throw new Error(`missing local agent ${localAgentId}`)
    this.db.prepare(`
      UPDATE local_agent_process_recipes SET
        tmux_name = COALESCE(?, tmux_name),
        cwd = COALESCE(?, cwd),
        permission_profile = COALESCE(?, permission_profile)
      WHERE local_agent_id = ?
    `).run(value(tmuxName), value(cwd), value(permissionProfile), local.localAgentId)
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
