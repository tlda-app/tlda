import fs from 'fs'
import os from 'os'
import path from 'path'
import { Worker } from 'worker_threads'
import Database from 'better-sqlite3'
import YAML from 'yaml'
import {
  emptyPrivilegeSet,
  normalizeRequestedPrivileges,
  normalizeSpawnPolicy,
} from '../../../server/lib/spawn-policy.mjs'

function nowIso() {
  return new Date().toISOString()
}

const WRITE_TIMEOUT_MS = Number(process.env.TLDA_PRIVILEGE_LEDGER_WRITE_TIMEOUT_MS || 5000)
const YAML_MIGRATION_META_KEY = 'migration.daemon-privileges-yaml.v1'

function normalizeLedgerGrant(value, fallback = 'none') {
  if (!value) {
    const policy = normalizeSpawnPolicy(fallback, 'none')
    return { spawnPolicy: policy, privilegeSet: emptyPrivilegeSet({ name: policy.name, projectedPolicy: policy }) }
  }
  const rawPrivilegeSet = value.privilegeSet || value.privileges || null
  if (rawPrivilegeSet) {
    const policy = value.spawnPolicy
      ? normalizeSpawnPolicy(value.spawnPolicy, fallback)
      : normalizeRequestedPrivileges(rawPrivilegeSet, fallback)
    const spawnPolicy = { ...policy }
    delete spawnPolicy.privilegeSet
    return { spawnPolicy, privilegeSet: withStoredSpawnDefault(rawPrivilegeSet, spawnPolicy) }
  }
  const policy = normalizeSpawnPolicy(value.spawnPolicy || value.policy || value.capability || value, fallback)
  return {
    spawnPolicy: policy,
    privilegeSet: policy.capability === 'none'
      ? emptyPrivilegeSet({ name: policy.name, projectedPolicy: policy })
      : null,
  }
}

function readYamlFile(file, label) {
  if (!fs.existsSync(file)) return {}
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch (e) {
    throw new Error(`cannot read ${label} ${file}: ${e.message}`)
  }
}

export class PrivilegeLedgerError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'PrivilegeLedgerError'
    this.code = code
    this.reason = code
    this.detail = detail
  }
}

function normalizeDaemonConfig(parsed) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const models = root.models && typeof root.models === 'object' && !Array.isArray(root.models)
    ? root.models
    : {}
  const ledger = root.ledger && typeof root.ledger === 'object' && !Array.isArray(root.ledger)
    ? root.ledger
    : {}
  const profiles = root.profiles && typeof root.profiles === 'object' && !Array.isArray(root.profiles)
    ? root.profiles
    : {}
  const classes = root.classes && typeof root.classes === 'object' && !Array.isArray(root.classes)
    ? root.classes
    : {}
  const assignments = root.assignments && typeof root.assignments === 'object' && !Array.isArray(root.assignments)
    ? root.assignments
    : {}
  const rootGrants = root.root_grants && typeof root.root_grants === 'object' && !Array.isArray(root.root_grants)
    ? root.root_grants
    : {}
  const serverIdentities = root.server_identities && typeof root.server_identities === 'object' && !Array.isArray(root.server_identities)
    ? root.server_identities
    : {}
  return {
    version: root.version || 1,
    profiles,
    classes,
    assignments,
    root_grants: rootGrants,
    models,
    server_identities: serverIdentities,
    ledger,
  }
}

function normalizeLegacyLedgerAgents(parsed) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const nested = root.privileges && typeof root.privileges === 'object' && !Array.isArray(root.privileges)
    ? root.privileges.agents
    : null
  const agents = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : root.agents && typeof root.agents === 'object' && !Array.isArray(root.agents)
      ? root.agents
      : {}
  return agents
}

function looksLikeDaemonModelRow(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      value.id != null
      || value.provider_model != null
      || value.providerModel != null
      || value.cap != null
      || value.capability != null
      || value.spawnPolicy != null
      || value.model_cap != null
    )
}

function daemonModelProvider(alias, row) {
  const provider = String(row.provider || row.provider_name || '').trim().toLowerCase()
  if (provider) return provider
  const id = String(row.id || row.provider_model || row.providerModel || alias || '')
  if (id.startsWith('claude-')) return 'claude'
  if (/^gpt/i.test(id)) return 'codex'
  if (id.startsWith('cursor-agent/')) return 'cursor-agent'
  return 'openrouter'
}

function normalizeDaemonModelRows(models = {}) {
  const aliases = {}
  const modelCeilings = {}
  for (const [key, value] of Object.entries(models || {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (!looksLikeDaemonModelRow(value)) {
      aliases[key] = value
      for (const [alias, entry] of Object.entries(value)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const cap = entry.cap || entry.capability || entry.spawnPolicy || entry.model_cap
        if (!cap) continue
        const id = entry.id || entry.provider_model || entry.providerModel
        modelCeilings[alias] = cap
        if (id) modelCeilings[id] = cap
      }
      continue
    }
    const provider = daemonModelProvider(key, value)
    const id = value.id || value.provider_model || value.providerModel || key
    aliases[provider] ||= {}
    aliases[provider][key] = {
      id,
      ...(value.provider_alias ? { provider_alias: value.provider_alias } : {}),
      ...(Array.isArray(value.tags) ? { tags: value.tags } : {}),
    }
    const cap = value.cap || value.capability || value.spawnPolicy || value.model_cap
    if (cap) {
      modelCeilings[key] = cap
      if (id) modelCeilings[id] = cap
    }
  }
  return { aliases, modelCeilings }
}

function withStoredSpawnDefault(privilegeSet, policy) {
  if (!privilegeSet || policy.capability === 'none') return privilegeSet
  if (privilegeSet.operations?.spawn) return privilegeSet
  return {
    ...privilegeSet,
    operations: {
      ...privilegeSet.operations,
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [
      ...(privilegeSet.rules || []),
      { operation: 'spawn', effect: 'allow', zone: '**', line: null },
    ],
  }
}

export class PrivilegeLedger {
  constructor(dbPath) {
    this.file = dbPath
    this.dbPath = dbPath
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS privilege_grants (
        id TEXT PRIMARY KEY,
        spawn_policy TEXT NOT NULL,
        privilege_set TEXT,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_privilege_grants_updated_at
        ON privilege_grants(updated_at);
    `)
    this._metaGet = this.db.prepare('SELECT value FROM ledger_meta WHERE key = ?')
    this._metaSet = this.db.prepare(`
      INSERT INTO ledger_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)
    this._get = this.db.prepare(`
      SELECT id, spawn_policy, privilege_set, updated_at, source
      FROM privilege_grants
      WHERE id = ?
    `)
    this._upsert = this.db.prepare(`
      INSERT INTO privilege_grants (id, spawn_policy, privilege_set, updated_at, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        spawn_policy = excluded.spawn_policy,
        privilege_set = excluded.privilege_set,
        updated_at = excluded.updated_at,
        source = excluded.source
    `)
    this._delete = this.db.prepare('DELETE FROM privilege_grants WHERE id = ?')
    this._worker = null
    this._nextRequestId = 1
    this._pending = new Map()
    this.migrateLegacyYamlIfNeeded()
  }

  migrateLegacyYamlIfNeeded() {
    if (this._metaGet.get(YAML_MIGRATION_META_KEY)) return { skipped: true, imported: 0 }
    const legacyFile = path.join(path.dirname(this.dbPath), 'daemon-privileges.yaml')
    if (!fs.existsSync(legacyFile)) {
      this._metaSet.run(YAML_MIGRATION_META_KEY, JSON.stringify({ imported: 0, file: legacyFile, missing: true }), nowIso())
      return { skipped: false, imported: 0 }
    }
    const parsed = readYamlFile(legacyFile, 'legacy daemon privilege ledger')
    const agents = normalizeLegacyLedgerAgents(parsed)
    let imported = 0
    const importOne = this.db.transaction(() => {
      for (const [id, sourceRow] of Object.entries(agents)) {
        if (!id || !sourceRow || typeof sourceRow !== 'object') continue
        const grant = normalizeLedgerGrant(sourceRow)
        const row = this.rowFor(id, {
          spawnPolicy: grant.spawnPolicy,
          privilegeSet: grant.privilegeSet,
          source: sourceRow.source || 'migration:daemon-privileges-yaml',
        })
        this._upsert.run(
          row.id,
          JSON.stringify(row.spawnPolicy),
          row.privilegeSet ? JSON.stringify(row.privilegeSet) : null,
          sourceRow.updatedAt || row.updatedAt,
          row.source,
        )
        imported++
      }
      this._metaSet.run(YAML_MIGRATION_META_KEY, JSON.stringify({ imported, file: legacyFile }), nowIso())
    })
    importOne()
    return { skipped: false, imported }
  }

  get(id) {
    const key = String(id || '').trim()
    if (!key) return null
    const row = this._get.get(key)
    if (!row) return null
    const parsed = {
      spawnPolicy: JSON.parse(row.spawn_policy),
      ...(row.privilege_set ? { privilegeSet: JSON.parse(row.privilege_set) } : {}),
    }
    const grant = normalizeLedgerGrant(parsed)
    return {
      id: row.id,
      spawnPolicy: grant.spawnPolicy,
      privilegeSet: grant.privilegeSet,
      updatedAt: row.updated_at,
      source: row.source || 'ledger',
    }
  }

  grantFor(agent) {
    const id = String(agent?.id || '').trim()
    const existing = this.get(id)
    if (existing) return existing
    throw new PrivilegeLedgerError(
      'SPAWN_PRIVILEGE_NO_LEDGER_ENTRY',
      `spawn refused: ${id || 'caller'} has no daemon privilege ledger entry`,
      { id: id || null },
    )
  }

  rowFor(id, { spawnPolicy, privilegeSet, source = 'spawn' } = {}) {
    const key = String(id || '').trim()
    if (!key) throw new Error('cannot persist daemon privilege grant without fleet id')
    const policy = normalizeSpawnPolicy(spawnPolicy, 'none')
    return {
      id: key,
      spawnPolicy: policy,
      privilegeSet: privilegeSet || (policy.capability === 'none'
        ? emptyPrivilegeSet({ name: policy.name, projectedPolicy: policy })
        : null),
      updatedAt: nowIso(),
      source,
    }
  }

  ensureWriter() {
    if (this._worker) return this._worker
    this._worker = new Worker(new URL('./privilege-ledger-writer.mjs', import.meta.url), {
      workerData: { dbPath: this.dbPath },
    })
    this._worker.unref()
    this._worker.on('message', (message) => {
      const pending = this._pending.get(message.requestId)
      if (!pending) return
      this._pending.delete(message.requestId)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve()
      else pending.reject(new Error(message.error || 'privilege ledger write failed'))
    })
    this._worker.on('error', (err) => {
      const pending = [...this._pending.values()]
      this._pending.clear()
      for (const item of pending) {
        clearTimeout(item.timer)
        item.reject(err)
      }
      this._worker = null
    })
    return this._worker
  }

  writeAsync(message, timeoutMs = WRITE_TIMEOUT_MS) {
    const worker = this.ensureWriter()
    const requestId = this._nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId)
        reject(new Error(`privilege ledger write timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this._pending.set(requestId, { resolve, reject, timer })
      worker.postMessage({ ...message, requestId })
    })
  }

  async set(id, options = {}) {
    const row = this.rowFor(id, options)
    await this.writeAsync({
      op: 'upsert',
      row: {
        id: row.id,
        spawnPolicy: JSON.stringify(row.spawnPolicy),
        privilegeSet: row.privilegeSet ? JSON.stringify(row.privilegeSet) : null,
        updatedAt: row.updatedAt,
        source: row.source,
      },
    })
    return row
  }

  async delete(id) {
    const key = String(id || '').trim()
    if (!key) return
    await this.writeAsync({ op: 'delete', id: key })
  }

  setSyncForTest(id, options = {}) {
    const row = this.rowFor(id, options)
    this._upsert.run(
      row.id,
      JSON.stringify(row.spawnPolicy),
      row.privilegeSet ? JSON.stringify(row.privilegeSet) : null,
      row.updatedAt,
      row.source,
    )
    return row
  }

  async close() {
    for (const item of this._pending.values()) clearTimeout(item.timer)
    this._pending.clear()
    const worker = this._worker
    this._worker = null
    this.db.close()
    if (worker) await worker.terminate()
  }
}

export function readDaemonConfig(file = defaultDaemonConfigPath()) {
  return normalizeDaemonConfig(readYamlFile(file, 'daemon config'))
}

export function withDaemonModelAliases(config = {}, daemonConfig = {}) {
  const daemonModels = daemonConfig?.models && typeof daemonConfig.models === 'object' && !Array.isArray(daemonConfig.models)
    ? daemonConfig.models
    : {}
  if (!Object.keys(daemonModels).length) return config || {}
  const { aliases, modelCeilings } = normalizeDaemonModelRows(daemonModels)
  return {
    ...(config || {}),
    models: aliases,
    spawnPolicy: {
      ...((config || {}).spawnPolicy || {}),
      modelCeilings: {
        ...(((config || {}).spawnPolicy || {}).modelCeilings || {}),
        ...modelCeilings,
      },
    },
  }
}

export function defaultPrivilegeLedgerPath(configDir = path.join(os.homedir(), '.config', 'tlda')) {
  return path.join(configDir, 'fleet-daemon.db')
}

export function defaultDaemonConfigPath(configDir = path.join(os.homedir(), '.config', 'tlda')) {
  return path.join(configDir, 'daemon.yaml')
}

export function privilegeLedgerPathFromDaemonConfig(daemonConfig = {}, configDir = path.join(os.homedir(), '.config', 'tlda')) {
  const raw = daemonConfig?.ledger?.db
  if (!raw) return defaultPrivilegeLedgerPath(configDir)
  const expanded = String(raw).startsWith('~/')
    ? path.join(os.homedir(), String(raw).slice(2))
    : String(raw)
  return path.isAbsolute(expanded) ? expanded : path.join(configDir, expanded)
}

export function createPrivilegeLedger(file = defaultPrivilegeLedgerPath()) {
  return new PrivilegeLedger(file)
}
