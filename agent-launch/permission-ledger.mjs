import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { Worker } from 'worker_threads'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import YAML from 'yaml'
import {
  compilePermissionGrant,
  normalizePermissionGrant,
} from '../server/lib/permission-grants.mjs'
import {
  validateDaemonConfigTopLevel,
  validateProjectDaemonOverrideTopLevel,
} from '../shared/daemon-config-schema.mjs'

function nowIso() {
  return new Date().toISOString()
}

const SESSION_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

function normalizeSessionIdForLedger(value) {
  const text = value == null || value === '' ? null : String(value)
  if (!text) return null
  return SESSION_UUID_RE.exec(text)?.[1] || text
}

function processBindingSignature(row = {}) {
  return JSON.stringify({
    id: row.id || null,
    sessionId: normalizeSessionIdForLedger(row.sessionId) || null,
    sessionKind: row.sessionKind || null,
    sessionPath: row.sessionPath || null,
    tmuxSession: row.tmuxSession || null,
    machineId: row.machineId || null,
    envName: row.envName || null,
    daemonKey: row.daemonKey || null,
    cwd: row.cwd || null,
  })
}

function hasProcessBinding(row = {}) {
  return !!(row?.id && row.sessionId && row.sessionKind && row.tmuxSession && row.daemonKey && row.cwd)
}

const WRITE_TIMEOUT_MS = Number(process.env.TLDA_PERMISSION_LEDGER_WRITE_TIMEOUT_MS || 5000)
const PERMISSION_LEDGER_SCHEMA_KEY = 'permission-ledger-schema'
const PERMISSION_LEDGER_SCHEMA_CURRENT = 'permission-grant-v1'

function normalizeLedgerGrant(value, config = null) {
  if (!value) {
    throw new PermissionLedgerError('SPAWN_PERMISSION_LEDGER_MISSING_GRANT', 'permission ledger grant is required')
  }
  const rawGrant = value.permissionGrant ?? value
  const permissionGrant = config
    ? normalizePermissionGrant(rawGrant, config)
    : normalizeStoredPermissionGrant(rawGrant)
  return {
    permissionGrant,
  }
}

function normalizeStoredPermissionGrant(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PermissionLedgerError('SPAWN_PERMISSION_LEDGER_INVALID_GRANT', 'permission grant must be a configured profile name or structured intersection')
  }
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.map((name) => String(name || '').trim()).filter(Boolean)
    : []
  const unique = [...new Set(profiles)]
  if (value.type !== 'permission-intersection' || unique.length < 2) {
    throw new PermissionLedgerError('SPAWN_PERMISSION_LEDGER_INVALID_GRANT', 'permission grant intersection requires at least two configured profile names')
  }
  return { type: 'permission-intersection', profiles: unique }
}

function ensureLedgerMetaTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function markPermissionGrantSchemaCurrent(db) {
  ensureLedgerMetaTable(db)
  db.prepare(`
    INSERT INTO ledger_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(PERMISSION_LEDGER_SCHEMA_KEY, PERMISSION_LEDGER_SCHEMA_CURRENT, nowIso())
}

function permissionGrantSchemaIsCurrent(db) {
  ensureLedgerMetaTable(db)
  const marked = db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get(PERMISSION_LEDGER_SCHEMA_KEY)?.value
  if (marked === PERMISSION_LEDGER_SCHEMA_CURRENT) return true
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'permission_grants'").get()
  if (!table) return true
  try {
    db.prepare('SELECT id, permission_grant FROM permission_grants LIMIT 0').all()
    markPermissionGrantSchemaCurrent(db)
    return true
  } catch {
    return false
  }
}

function runHistoricalPermissionGrantMigration(dbPath) {
  const script = fileURLToPath(new URL('../migrations/permissions/permission-grants-v1.mjs', import.meta.url))
  execFileSync(process.execPath, [script, dbPath], { stdio: 'inherit' })
}

function readYamlFile(file, label) {
  if (!fs.existsSync(file)) return {}
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch (e) {
    throw new Error(`cannot read ${label} ${file}: ${e.message}`)
  }
}

export class PermissionLedgerError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'PermissionLedgerError'
    this.code = code
    this.reason = code
    this.detail = detail
  }
}

function validateDaemonDefault(config = {}) {
  if (config.default && !(config.profiles || {})[config.default]) {
    throw new Error(`daemon default references unknown profile "${config.default}"`)
  }
  return config
}

function validateDaemonConfig(parsed, { validateDefault = true } = {}) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : parsed
  validateDaemonConfigTopLevel(root, 'daemon config')
  return validateDefault ? validateDaemonDefault(root) : root
}

function validateProjectDaemonOverride(parsed) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : parsed
  validateProjectDaemonOverrideTopLevel(root, 'project daemon override')
  return root
}

// Deep-merge helper for the base ⊕ project-override join (project values win).
function joinConfigs(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? joinConfigs(base[k], v)
      : v
  }
  return out
}

function normalizeOperationZones(value = {}) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const allow = Array.isArray(row.allow) ? row.allow.filter(v => typeof v === 'string' && v.trim()) : []
  const deny = Array.isArray(row.deny) ? row.deny.filter(v => typeof v === 'string' && v.trim()) : []
  return { allow, deny }
}

function normalizeDaemonRegions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const regions = {}
  for (const [name, paths] of Object.entries(source)) {
    const key = String(name || '').trim().toLowerCase()
    if (!key) continue
    if (!Array.isArray(paths)) throw new Error(`daemon region "${name}" must be a path list`)
    regions[key] = paths.filter(path => typeof path === 'string' && path.trim())
  }
  return regions
}

function expandProfileRegionRefs(refs, regions, { profile, operation, effect }) {
  const out = []
  for (const ref of refs) {
    const key = String(ref || '').trim().toLowerCase()
    if (!key) continue
    const region = regions[key]
    if (!region) throw new Error(`daemon profile "${profile}" ${operation}.${effect} references unknown region "${ref}"`)
    out.push(...region)
  }
  return out
}

function normalizeProfileRootRefs(value = {}, regions, context) {
  const refs = normalizeOperationZones(value)
  return {
    allow: expandProfileRegionRefs(refs.allow, regions, { ...context, effect: 'allow' }),
    deny: expandProfileRegionRefs(refs.deny, regions, { ...context, effect: 'deny' }),
  }
}

function normalizeDaemonProfile(name, value, regions) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`daemon profile "${name}" must be an object`)
  }
  // `description` is an inert, operator-owned help string: the daemon ignores it
  // for policy, but the CLI help and docs read it so the profile's name AND its
  // human description live in one place (daemon.yaml) and can't drift.
  const allowed = new Set(['read', 'write', 'description'])
  const extra = Object.keys(value).filter(key => !allowed.has(key))
  if (extra.length) throw new Error(`daemon profile "${name}" supports only read, write, and description; unknown key(s): ${extra.join(', ')}`)
  const operations = {
    read: normalizeProfileRootRefs(value.read, regions, { profile: name, operation: 'read' }),
    write: normalizeProfileRootRefs(value.write, regions, { profile: name, operation: 'write' }),
    spawn: { allow: [], deny: [] },
  }
  const rules = []
  for (const operation of ['read', 'write']) {
    for (const effect of ['allow', 'deny']) {
      for (const zone of operations[operation][effect]) {
        rules.push({ operation, effect, zone, line: null })
      }
    }
  }
  return {
    type: 'permission-set',
    name,
    operations,
    rules,
    compiledFrom: 'daemon.yaml',
    ...(typeof value.description === 'string' && value.description.trim()
      ? { description: value.description.trim() }
      : {}),
  }
}

function normalizeDaemonProfiles(value, regions) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const profiles = {}
  for (const [name, profile] of Object.entries(source)) {
    const key = String(name || '').trim().toLowerCase()
    if (!key) continue
    profiles[key] = normalizeDaemonProfile(key, profile, regions)
  }
  return profiles
}

function normalizeChoiceOptions(options = {}, context = 'options') {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  const out = {}
  for (const [name, spec] of Object.entries(source)) {
    const key = String(name || '').trim()
    if (!key) continue
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${context}.${key} must be an object with default and values`)
    }
    const values = spec.values && typeof spec.values === 'object' && !Array.isArray(spec.values)
      ? spec.values
      : null
    if (!values) throw new Error(`${context}.${key}.values must be an object`)
    const valueKeys = Object.keys(values).map(v => String(v).trim()).filter(Boolean)
    if (!valueKeys.length) throw new Error(`${context}.${key}.values must not be empty`)
    const defaultValue = String(spec.default || '').trim()
    if (!defaultValue) throw new Error(`${context}.${key}.default is required`)
    if (!Object.prototype.hasOwnProperty.call(values, defaultValue)) {
      throw new Error(`${context}.${key}.default "${defaultValue}" is not in values`)
    }
    out[key] = {
      default: defaultValue,
      values: Object.fromEntries(Object.entries(values).map(([valueName, valueSpec]) => {
        const valueKey = String(valueName || '').trim()
        if (!valueKey) return null
        const row = valueSpec && typeof valueSpec === 'object' && !Array.isArray(valueSpec) ? valueSpec : {}
        return [valueKey, {
          ...(row.description ? { description: String(row.description) } : {}),
          ...(row.options ? { options: normalizeChoiceOptions(row.options, `${context}.${key}.values.${valueKey}.options`) } : {}),
        }]
      }).filter(Boolean)),
    }
  }
  return out
}

function normalizeDaemonModelRows(models = {}) {
  const aliases = {}
  const harnessOptions = {}
  const modelSpecs = {}
  let defaultModel = null
  function addModelSpec(alias, provider, value, defaults = {}) {
    const row = typeof value === 'string' ? { id: value } : (value || {})
    if (!row || typeof row !== 'object' || Array.isArray(row)) return
    const key = String(alias || '').trim()
    if (!key || key === '*') return
    const explicitProvider = String(row.provider || row.provider_name || defaults.provider || provider || '').trim().toLowerCase()
    const harness = String(row.kind || row.harness?.kind || row.harness_kind || row.launch?.kind || defaults.harness || '').trim().toLowerCase()
    if (!harness) throw new Error(`daemon model "${key}" must specify a harness/provider`)
    const id = row.id || row.provider_model || row.providerModel || (typeof value === 'string' ? value : null)
    if (!id) throw new Error(`daemon model "${key}" must specify an id/provider_model`)
    const cap = row.cap || row.permission || row.permissionGrant || row.model_cap || null
    const ownHarnessOptions = normalizeHarnessOptions(row)
    const inheritedHarnessOptions = defaults.harnessOptions || { required: [], preferences: [], controls: false, options: {} }
    const group = String(row.group || defaults.group || explicitProvider || harness).trim()
    const level = row.level == null ? null : Number(row.level)
    if (row.level != null && !Number.isFinite(level)) throw new Error(`daemon model "${key}" level must be numeric`)
    modelSpecs[key] = {
      alias: key,
      id: String(id),
      provider: explicitProvider || harness,
      harness,
      group,
      ...(level == null ? {} : { level }),
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      options: normalizeChoiceOptions(row.options, `models.values.${key}.options`),
      ...(Array.isArray(row.tags) ? { tags: row.tags } : {}),
      ...(typeof row.available === 'boolean' ? { available: row.available } : {}),
      ...(typeof row.verified === 'boolean' ? { verified: row.verified } : {}),
      ...(cap ? { cap } : {}),
      harnessOptions: (ownHarnessOptions.required.length || ownHarnessOptions.preferences.length || ownHarnessOptions.controls || Object.keys(ownHarnessOptions.options).length)
        ? ownHarnessOptions
        : inheritedHarnessOptions,
    }
    const providerKey = explicitProvider || harness
    aliases[providerKey] ||= {}
    aliases[providerKey][key] = {
      id: String(id),
      ...(row.provider_alias ? { provider_alias: row.provider_alias } : {}),
      ...(Array.isArray(row.tags) ? { tags: row.tags } : {}),
    }
  }
  const canonical = models
    && typeof models === 'object'
    && !Array.isArray(models)
    && models.values
    && typeof models.values === 'object'
    && !Array.isArray(models.values)
  if (canonical) {
    defaultModel = String(models.default || '').trim() || null
    if (!defaultModel) throw new Error('models.default is required when models.values is configured')
    for (const [alias, entry] of Object.entries(models.values)) {
      addModelSpec(alias, null, entry, {})
    }
    if (defaultModel && !modelSpecs[defaultModel]) {
      throw new Error(`models.default "${defaultModel}" is not in models.values`)
    }
    return { aliases, harnessOptions, modelSpecs, defaultModel }
  }
  if (Object.keys(models || {}).length) {
    throw new Error('daemon models must use { default, values }')
  }
  return { aliases, harnessOptions, modelSpecs, defaultModel }
}

function stringList(value, label) {
  if (value == null) return []
  if (typeof value === 'string') return [value].filter(v => v.trim())
  if (!Array.isArray(value)) throw new Error(`${label} must be a string or string list`)
  return value.map(v => String(v || '').trim()).filter(Boolean)
}

function normalizeHarnessOptions(row = {}) {
  const source = row.harness || row.launch || row
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { required: [], preferences: [], controls: false, options: {} }
  }
  const required = stringList(source.required || source.required_flags || source.requiredFlags, 'harness required flags')
  const preferences = stringList(source.preferences || source.preference_flags || source.preferenceFlags, 'harness preference flags')
  const controls = source.controls === false
    ? false
    : (source.controls === true || required.length > 0)
  const options = source.options == null
    ? {}
    : Object.fromEntries(Object.entries(source.options).map(([name, values]) => [
      String(name).trim(),
      stringList(values, `harness option "${name}"`),
    ]).filter(([name, values]) => name && values.length))
  return {
    required,
    preferences,
    controls,
    options,
  }
}

export class PermissionLedger {
  constructor(dbPath, { onProcessBindingChange } = {}) {
    this.file = dbPath
    this.dbPath = dbPath
    this.onProcessBindingChange = typeof onProcessBindingChange === 'function' ? onProcessBindingChange : null
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    if (!permissionGrantSchemaIsCurrent(this.db)) {
      this.db.close()
      runHistoricalPermissionGrantMigration(dbPath)
      this.db = new Database(dbPath)
      this.db.pragma('busy_timeout = 5000')
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = NORMAL')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS permission_grants (
        id TEXT PRIMARY KEY,
        permission_grant TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL,
        friendly_name TEXT,
        session_id TEXT,
        session_kind TEXT,
        session_path TEXT,
        tmux_session TEXT,
        model TEXT,
        machine_id TEXT,
        env_name TEXT,
        daemon_key TEXT,
        terminal_capability TEXT,
        cwd TEXT,
        last_seen TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_permission_grants_updated_at
        ON permission_grants(updated_at);
    `)
    markPermissionGrantSchemaCurrent(this.db)
    for (const ddl of [
      'ALTER TABLE permission_grants ADD COLUMN friendly_name TEXT',
      'ALTER TABLE permission_grants ADD COLUMN session_id TEXT',
      'ALTER TABLE permission_grants ADD COLUMN session_kind TEXT',
      'ALTER TABLE permission_grants ADD COLUMN session_path TEXT',
      'ALTER TABLE permission_grants ADD COLUMN tmux_session TEXT',
      'ALTER TABLE permission_grants ADD COLUMN model TEXT',
      'ALTER TABLE permission_grants ADD COLUMN machine_id TEXT',
      'ALTER TABLE permission_grants ADD COLUMN env_name TEXT',
      'ALTER TABLE permission_grants ADD COLUMN daemon_key TEXT',
      'ALTER TABLE permission_grants ADD COLUMN terminal_capability TEXT',
      'ALTER TABLE permission_grants ADD COLUMN cwd TEXT',
      'ALTER TABLE permission_grants ADD COLUMN last_seen TEXT',
    ]) {
      try { this.db.exec(ddl) } catch (e) {
        if (!String(e?.message || '').includes('duplicate column name')) throw e
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_permission_grants_friendly_name
        ON permission_grants(friendly_name, last_seen);
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
      SELECT id, permission_grant, updated_at, source,
        friendly_name, session_id, session_kind, session_path, tmux_session, model,
        machine_id, env_name, daemon_key, terminal_capability, cwd, last_seen
      FROM permission_grants
      WHERE id = ?
    `)
    this._findByFriendlyName = this.db.prepare(`
      SELECT id, permission_grant, updated_at, source,
        friendly_name, session_id, session_kind, session_path, tmux_session, model,
        machine_id, env_name, daemon_key, terminal_capability, cwd, last_seen
      FROM permission_grants
      WHERE friendly_name = ?
      ORDER BY COALESCE(last_seen, updated_at) DESC
      LIMIT 1
    `)
    this._list = this.db.prepare(`
      SELECT id, permission_grant, updated_at, source,
        friendly_name, session_id, session_kind, session_path, tmux_session, model,
        machine_id, env_name, daemon_key, terminal_capability, cwd, last_seen
      FROM permission_grants
      WHERE tmux_session IS NOT NULL
      ORDER BY id
    `)
    this._upsert = this.db.prepare(`
      INSERT INTO permission_grants (id, permission_grant, updated_at, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        permission_grant = excluded.permission_grant,
        updated_at = excluded.updated_at,
        source = excluded.source
    `)
    this._delete = this.db.prepare('DELETE FROM permission_grants WHERE id = ?')
    this._worker = null
    this._nextRequestId = 1
    this._pending = new Map()
  }

  get(id) {
    const key = String(id || '').trim()
    if (!key) return null
    const row = this._get.get(key)
    return this.parseRow(row)
  }

  findByFriendlyName(name) {
    const key = String(name || '').trim()
    if (!key) return null
    return this.parseRow(this._findByFriendlyName.get(key))
  }

  listProcessBindings() {
    return this._list.all().map(row => this.parseRow(row))
  }

  parseRow(row) {
    if (!row) return null
    const parsed = {
      permissionGrant: JSON.parse(row.permission_grant),
    }
    const grant = normalizeLedgerGrant(parsed)
    return {
      id: row.id,
      permissionGrant: grant.permissionGrant,
      updatedAt: row.updated_at,
      source: row.source || 'ledger',
      friendlyName: row.friendly_name || null,
      sessionId: row.session_id || null,
      sessionKind: row.session_kind || null,
      sessionPath: row.session_path || null,
      tmuxSession: row.tmux_session || null,
      model: row.model || null,
      machineId: row.machine_id || null,
      envName: row.env_name || null,
      daemonKey: row.daemon_key || null,
      terminalCapability: row.terminal_capability || null,
      cwd: row.cwd || null,
      lastSeen: row.last_seen || null,
    }
  }

  grantFor(agent) {
    const id = String(agent?.id || '').trim()
    const existing = this.get(id)
    if (existing) return existing
    throw new PermissionLedgerError(
      'SPAWN_PERMISSION_NO_LEDGER_ENTRY',
      `spawn refused: ${id || 'caller'} has no daemon permission ledger entry`,
      { id: id || null },
    )
  }

  rowFor(id, { permissionGrant, source = 'spawn' } = {}) {
    const key = String(id || '').trim()
    if (!key) throw new Error('cannot persist daemon permission grant without fleet id')
    const grant = normalizeStoredPermissionGrant(permissionGrant)
    return {
      id: key,
      permissionGrant: grant,
      updatedAt: nowIso(),
      source,
    }
  }

  ensureWriter() {
    if (this._worker) return this._worker
    this._worker = new Worker(new URL('./permission-ledger-writer.mjs', import.meta.url), {
      workerData: { dbPath: this.dbPath },
    })
    this._worker.unref()
    this._worker.on('message', (message) => {
      const pending = this._pending.get(message.requestId)
      if (!pending) return
      this._pending.delete(message.requestId)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve()
      else pending.reject(new Error(message.error || 'permission ledger write failed'))
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
        if (this.writeLanded(message)) {
          resolve()
          return
        }
        reject(new Error(`permission ledger write timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this._pending.set(requestId, { resolve, reject, timer })
      worker.postMessage({ ...message, requestId })
    })
  }

  writeLanded(message = {}) {
    try {
      if (message.op === 'upsert') {
        const expected = message.row || {}
        if (!expected.id) return false
        const row = this._get.get(expected.id)
        return !!row
          && row.permission_grant === expected.permissionGrant
          && row.updated_at === expected.updatedAt
          && row.source === expected.source
      }
      if (message.op === 'delete') {
        return !message.id || !this._get.get(message.id)
      }
      return false
    } catch {
      return false
    }
  }

  async set(id, options = {}) {
    const row = this.rowFor(id, options)
    await this.writeAsync({
      op: 'upsert',
      row: {
        id: row.id,
        permissionGrant: JSON.stringify(row.permissionGrant),
        updatedAt: row.updatedAt,
        source: row.source,
      },
    })
    return row
  }

  // Deleting a row destroys the agent's permission grant, which is what `wake`
  // reads — this is the documented cause of the "wake refused: no ledger entry"
  // failure class. The existing callers are spawn-failure cleanup, where the
  // agent never came into being. Do not reach for this to prune stale rows: to
  // retire a dead session, clear `tmux_session` and leave the grant, so the
  // agent stays wakeable (see the note in daemon/agent-liveness.mjs).
  async delete(id) {
    const key = String(id || '').trim()
    if (!key) return
    const existing = this.get(key)
    await this.writeAsync({ op: 'delete', id: key })
    if (hasProcessBinding(existing)) {
      this.notifyProcessBindingChange({ id: key, row: null, previous: existing, deleted: true })
    }
  }

  deleteSyncForTest(id) {
    const key = String(id || '').trim()
    if (!key) return
    const existing = this.get(key)
    this._delete.run(key)
    if (hasProcessBinding(existing)) {
      this.notifyProcessBindingChange({ id: key, row: null, previous: existing, deleted: true })
    }
  }

  notifyProcessBindingChange(event) {
    if (!this.onProcessBindingChange) return
    try {
      this.onProcessBindingChange(event)
    } catch (e) {
      console.warn?.(`[permission-ledger] process binding observer failed for ${event?.id || 'unknown'}: ${e?.message || e}`)
    }
  }

  setSyncForTest(id, options = {}) {
    return this.setSync(id, options)
  }

  setSync(id, options = {}) {
    const row = this.rowFor(id, options)
    this._upsert.run(
      row.id,
      JSON.stringify(row.permissionGrant),
      row.updatedAt,
      row.source,
    )
    return row
  }

  setSessionSync(id, {
    sessionId,
    sessionKind,
    sessionPath,
    tmuxSession,
    model,
    machineId,
    envName,
    daemonKey,
    terminalCapability,
    cwd,
    friendlyName,
    lastSeen = nowIso(),
  } = {}) {
    const key = String(id || '').trim()
    if (!key) throw new Error('cannot persist daemon session identity without fleet id')
    if (!sessionId && !sessionKind && !sessionPath && !tmuxSession && !model && !machineId && !envName && !daemonKey && !terminalCapability && !cwd && !friendlyName) return this.get(key)
    const existing = this.get(key)
    if (!existing) {
      return null
    }
    const beforeBindingSignature = processBindingSignature(existing)
    const normalizedSessionId = normalizeSessionIdForLedger(sessionId)
    // Identity is the local process tuple. Route fields, `model`, and `cwd` are metadata, not
    // identity: a model ALIAS vs its resolved name ('fable' vs
    // 'claude-fable-5') bounced every wake of a healthy seat, and a worktree
    // cwd vs the repo root rejected legitimate worktree logins (both 7/17).
    // They still persist fill-null-only below; they just cannot conflict.
    const incoming = {
      sessionId: normalizedSessionId,
      sessionKind,
      sessionPath,
      tmuxSession,
    }
    for (const [field, value] of Object.entries(incoming)) {
      const normalized = value == null || value === '' ? null : String(value)
      const current = field === 'sessionId'
        ? normalizeSessionIdForLedger(existing[field])
        : (existing[field] == null || existing[field] === '' ? null : String(existing[field]))
      if (normalized && current && normalized !== current) {
        throw new Error(`daemon ledger identity conflict for ${key}: ${field} existing=${current} incoming=${normalized}`)
      }
    }
    this.db.prepare(`
      UPDATE permission_grants SET
        session_id = COALESCE(?, session_id),
        session_kind = COALESCE(session_kind, ?),
        session_path = COALESCE(session_path, ?),
        tmux_session = COALESCE(tmux_session, ?),
        model = COALESCE(model, ?),
        machine_id = COALESCE(machine_id, ?),
        env_name = COALESCE(env_name, ?),
        daemon_key = COALESCE(daemon_key, ?),
        terminal_capability = COALESCE(terminal_capability, ?),
        cwd = COALESCE(cwd, ?),
        friendly_name = COALESCE(?, friendly_name),
        last_seen = ?
      WHERE id = ?
    `).run(
      normalizedSessionId || null,
      sessionKind || null,
      sessionPath || null,
      tmuxSession || null,
      model || null,
      machineId || null,
      envName || null,
      daemonKey || null,
      terminalCapability || null,
      cwd || null,
      friendlyName || null,
      lastSeen,
      key,
    )
    const updated = this.get(key)
    if (processBindingSignature(updated) !== beforeBindingSignature) {
      this.notifyProcessBindingChange({ id: key, row: updated, previous: existing })
    }
    return updated
  }

  clearSessionSync(id, { lastSeen = nowIso() } = {}) {
    const key = String(id || '').trim()
    if (!key) throw new Error('cannot clear daemon session identity without fleet id')
    const existing = this.get(key)
    if (!existing) return null
    this.db.prepare(`
      UPDATE permission_grants SET
        session_id = NULL,
        session_kind = NULL,
        session_path = NULL,
        tmux_session = NULL,
        model = NULL,
        machine_id = NULL,
        env_name = NULL,
        daemon_key = NULL,
        terminal_capability = NULL,
        cwd = NULL,
        last_seen = ?
      WHERE id = ?
    `).run(lastSeen, key)
    const updated = this.get(key)
    if (hasProcessBinding(existing)) {
      this.notifyProcessBindingChange({ id: key, row: updated, previous: existing })
    }
    return updated
  }

  rotateTerminalCapabilitySync(id) {
    const key = String(id || '').trim()
    if (!key) throw new Error('cannot mint terminal capability without fleet id')
    const existing = this.get(key)
    if (!existing) return null
    const capability = `termcap:${randomUUID()}`
    this.db.prepare(`
      UPDATE permission_grants
      SET terminal_capability = ?, last_seen = ?
      WHERE id = ?
    `).run(capability, nowIso(), key)
    return capability
  }

  resolveTerminalCapability({ agentId, terminalCapability } = {}) {
    const key = String(agentId || '').trim()
    const capability = String(terminalCapability || '').trim()
    if (!key || !capability) return null
    const row = this.get(key)
    if (!row || row.terminalCapability !== capability) return null
    if (!row.tmuxSession || !row.sessionId || !row.daemonKey) return null
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
  return validateDaemonConfig(readYamlFile(file, 'daemon config'))
}

// Git-style project override: walk up from the agent's cwd for a `.tlda-daemon.yaml`.
export function projectDaemonOverridePath(cwd) {
  let dir = cwd ? path.resolve(cwd) : null
  while (dir) {
    const f = path.join(dir, '.tlda-daemon.yaml')
    if (fs.existsSync(f)) return f
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Walk-up found nothing. If cwd is a git worktree (e.g. an app agent in
  // /private/tmp/*-wt), its `.tlda-daemon.yaml` lives in the MAIN checkout — a
  // linked worktree does not copy the main tree's untracked/gitignored files, so
  // walk-up alone misses it and the agent falls to the base `wd` cage. Resolve the
  // main checkout via `git rev-parse --git-common-dir` (the canonical way, robust
  // vs. hand-parsing the `.git` file): it yields `<main-checkout>/.git`, so its
  // parent is the main checkout root — look for the override there. Any non-git cwd
  // or git error falls through to null (base profile), unchanged from today. The
  // walk-up runs first, so a worktree carrying its own `.tlda-daemon.yaml` wins.
  if (cwd) {
    try {
      const resolved = path.resolve(cwd)
      const commonDir = execFileSync('git', ['-C', resolved, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (commonDir) {
        const mainCheckout = path.dirname(path.resolve(resolved, commonDir))
        const f = path.join(mainCheckout, '.tlda-daemon.yaml')
        if (fs.existsSync(f)) return f
      }
    } catch { /* non-git cwd or git error → base profile (null), unchanged from today */ }
  }
  return null
}

// Resolve the daemon config an agent in `cwd` sees: the base config deep-joined
// with its project's `.tlda-daemon.yaml`, the project's values overwriting (like a
// git config local override, or a DB join with the project row winning).
export function readDaemonConfigForCwd(cwd, file = defaultDaemonConfigPath()) {
  const base = readDaemonConfig(file)
  const overridePath = projectDaemonOverridePath(cwd)
  if (!overridePath) return base
  const override = validateProjectDaemonOverride(readYamlFile(overridePath, 'project daemon override'))
  return validateDaemonDefault(joinConfigs(base, override))
}

export function withDaemonModelAliases(config = {}, daemonConfig = {}) {
  const regions = normalizeDaemonRegions(daemonConfig?.regions)
  const daemonProfiles = normalizeDaemonProfiles(daemonConfig?.profiles, regions)
  const daemonModels = daemonConfig?.models && typeof daemonConfig.models === 'object' && !Array.isArray(daemonConfig.models)
    ? daemonConfig.models
    : {}
  // No daemon models AND no daemon profiles: return an empty daemon authority.
  // Fail closed: no profiles means no permission profiles.
  if (!Object.keys(daemonModels).length && !Object.keys(daemonProfiles).length) return { permissionProfiles: {} }
  const { aliases, harnessOptions, modelSpecs, defaultModel } = normalizeDaemonModelRows(daemonModels)
  // Permission grants, model aliases, specs, and catalog are daemon-owned.
  return {
    ...(Object.keys(modelSpecs).length ? { modelSpecs } : {}),
    ...(Object.keys(modelSpecs).length ? { modelCatalog: { default: defaultModel, values: modelSpecs } } : {}),
    ...(Object.keys(aliases).length ? { models: aliases } : {}),
    ...(Object.keys(harnessOptions).length ? { harnessOptions } : {}),
    permissionProfiles: { ...daemonProfiles },
    defaultPermissionProfile: daemonConfig.default || null,
  }
}

export function applyDaemonGrants(ledger, daemonConfig = {}) {
  const grants = daemonConfig?.grants && typeof daemonConfig.grants === 'object' && !Array.isArray(daemonConfig.grants)
    ? daemonConfig.grants
    : {}
  const regions = normalizeDaemonRegions(daemonConfig?.regions)
  const profiles = normalizeDaemonProfiles(daemonConfig?.profiles, regions)
  let written = 0
  for (const [id, value] of Object.entries(grants)) {
    const permissionGrant = normalizePermissionGrant(value, { permissionProfiles: profiles })
    const grant = normalizeLedgerGrant({ permissionGrant })
    ledger.setSync(id, {
      permissionGrant: grant.permissionGrant,
      source: 'daemon.yaml:grants',
    })
    written++
  }
  return { written }
}

export function defaultPermissionLedgerPath(configDir = process.env.TLDA_DAEMON_CONFIG_DIR || path.join(os.homedir(), '.config', 'tlda')) {
  return path.join(configDir, 'fleet-daemon.db')
}

export function defaultDaemonConfigPath(configDir = process.env.TLDA_DAEMON_CONFIG_DIR || path.join(os.homedir(), '.config', 'tlda')) {
  return path.join(configDir, 'daemon.yaml')
}

export function permissionLedgerPathFromDaemonConfig(daemonConfig = {}, configDir = process.env.TLDA_DAEMON_CONFIG_DIR || path.join(os.homedir(), '.config', 'tlda')) {
  return defaultPermissionLedgerPath(configDir)
}

export function createPermissionLedger(file = defaultPermissionLedgerPath(), options = {}) {
  return new PermissionLedger(file, options)
}
