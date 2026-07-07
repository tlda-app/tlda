import fs from 'fs'
import os from 'os'
import path from 'path'
import { Worker } from 'worker_threads'
import Database from 'better-sqlite3'
import YAML from 'yaml'
import {
  emptyPermissionSet,
  resolveSpawnGrant,
  normalizeRegionPolicy,
  regionPolicyFromSet,
} from '../../../server/lib/spawn-policy.mjs'

function nowIso() {
  return new Date().toISOString()
}

const WRITE_TIMEOUT_MS = Number(process.env.TLDA_PERMISSION_LEDGER_WRITE_TIMEOUT_MS || 5000)
const YAML_MIGRATION_META_KEY = 'migration.daemon-permissions-yaml.v1'

// An explicit empty ('none') grant — confers nothing. Detected off the raw input so a
// stored 'none' still materializes as an empty permission set after the level strip.
function isNoneGrant(value) {
  if (value == null || value === '') return false
  const s = typeof value === 'string' ? value : (value.permission ?? value.policy ?? value.name ?? '')
  return String(s).trim().toLowerCase() === 'none'
}

function normalizeLedgerGrant(value, fallback = 'none') {
  if (!value) {
    const policy = normalizeRegionPolicy(fallback)
    return { spawnPolicy: policy, permissionSet: emptyPermissionSet({ name: policy.name, projectedPolicy: policy }) }
  }
  const rawPermissionSet = value.permissionSet || value.permissions || null
  if (rawPermissionSet) {
    // The region set IS the grant; its region scope is read off value.spawnPolicy (new
    // region blob or a legacy level blob) or derived from the set itself.
    const spawnPolicy = value.spawnPolicy
      ? normalizeRegionPolicy(value.spawnPolicy, fallback)
      : regionPolicyFromSet(rawPermissionSet)
    return { spawnPolicy, permissionSet: withStoredSpawnDefault(rawPermissionSet, spawnPolicy) }
  }
  const raw = value.spawnPolicy || value.policy || value.permission || value
  const spawnPolicy = normalizeRegionPolicy(raw, fallback)
  return {
    spawnPolicy,
    permissionSet: isNoneGrant(raw)
      ? emptyPermissionSet({ name: spawnPolicy.name, projectedPolicy: spawnPolicy })
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

export class PermissionLedgerError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'PermissionLedgerError'
    this.code = code
    this.reason = code
    this.detail = detail
  }
}

function normalizeDaemonConfig(parsed) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const allowed = new Set(['regions', 'profiles', 'grants', 'models', 'servers', 'default'])
  const extra = Object.keys(root).filter(key => !allowed.has(key))
  if (extra.length) throw new Error(`daemon config supports only regions, profiles, grants, models, servers, default; unknown key(s): ${extra.join(', ')}`)
  const models = root.models && typeof root.models === 'object' && !Array.isArray(root.models)
    ? root.models
    : {}
  const regions = normalizeDaemonRegions(root.regions)
  const profiles = normalizeDaemonProfiles(root.profiles, regions)
  const grants = root.grants && typeof root.grants === 'object' && !Array.isArray(root.grants)
    ? root.grants
    : {}
  const servers = root.servers && typeof root.servers === 'object' && !Array.isArray(root.servers)
    ? root.servers
    : {}
  const defaultProfile = typeof root.default === 'string' && root.default.trim() ? root.default.trim() : null
  return {
    regions,
    profiles,
    grants,
    models,
    servers,
    ...(defaultProfile ? { default: defaultProfile } : {}),
  }
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

function derivedPolicyFromOperations(name, operations) {
  const writeAllow = operations.write?.allow || []
  const hasUniversalWrite = writeAllow.some(zone => zone === '**' || zone === '/' || zone === '/**')
  const hasTldaWrite = writeAllow.some(zone => zone === 'tlda-projects')
  // The fence REGION this profile's zones cover — not a level.
  const policy = hasUniversalWrite ? 'unsandboxed' : hasTldaWrite ? 'tlda-projects' : 'cwd'
  return { name, policy }
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
  const policy = derivedPolicyFromOperations(name, operations)
  return {
    type: 'permission-set',
    name,
    operations,
    rules,
    projectedPolicy: policy,
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

function normalizeLegacyLedgerAgents(parsed) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const nested = root.permissions && typeof root.permissions === 'object' && !Array.isArray(root.permissions)
    ? root.permissions.agents
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
      || value.permission != null
      || value.spawnPolicy != null
      || value.model_cap != null
      || value.harness != null
      || value.launch != null
      || value.required_flags != null
      || value.requiredFlags != null
      || value.preferences != null
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
  const harnessOptions = {}
  function mergeHarnessOptions(harness, alias, row) {
    const normalized = normalizeHarnessOptions(row)
    const key = String(harness || '').trim().toLowerCase()
    if (!key) return
    harnessOptions[key] ||= {}
    if (alias) harnessOptions[key][alias] = normalized
    if (row?.id || row?.provider_model || row?.providerModel) {
      harnessOptions[key][row.id || row.provider_model || row.providerModel] = normalized
    }
  }
  for (const [key, value] of Object.entries(models || {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (!looksLikeDaemonModelRow(value)) {
      const providerAliases = {}
      for (const [alias, entry] of Object.entries(value)) {
        if (typeof entry === 'string') {
          providerAliases[alias] = entry
          continue
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        mergeHarnessOptions(key, alias, entry)
        const cap = entry.cap || entry.permission || entry.spawnPolicy || entry.model_cap
        const id = entry.id || entry.provider_model || entry.providerModel
        if (id) providerAliases[alias] = {
          id,
          ...(entry.provider_alias ? { provider_alias: entry.provider_alias } : {}),
          ...(Array.isArray(entry.tags) ? { tags: entry.tags } : {}),
        }
        if (cap) {
          modelCeilings[alias] = cap
          if (id) modelCeilings[id] = cap
        }
      }
      if (Object.keys(providerAliases).length) aliases[key] = providerAliases
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
    const cap = value.cap || value.permission || value.spawnPolicy || value.model_cap
    if (cap) {
      modelCeilings[key] = cap
      if (id) modelCeilings[id] = cap
    }
    mergeHarnessOptions(provider, key, value)
  }
  return { aliases, modelCeilings, harnessOptions }
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
    return { required: [], preferences: [], controls: false }
  }
  const required = stringList(source.required || source.required_flags || source.requiredFlags, 'harness required flags')
  const preferences = stringList(source.preferences || source.preference_flags || source.preferenceFlags, 'harness preference flags')
  const controls = source.controls === false
    ? false
    : (source.controls === true || required.length > 0)
  return {
    required,
    preferences,
    controls,
  }
}

function withStoredSpawnDefault(permissionSet, policy) {
  if (!permissionSet || policy.permission === 'none') return permissionSet
  if (permissionSet.operations?.spawn) return permissionSet
  return {
    ...permissionSet,
    operations: {
      ...permissionSet.operations,
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [
      ...(permissionSet.rules || []),
      { operation: 'spawn', effect: 'allow', zone: '**', line: null },
    ],
  }
}

function allPermissionSet(name = 'full') {
  return {
    type: 'permission-set',
    name,
    operations: {
      read: { allow: ['**'], deny: [] },
      write: { allow: ['**'], deny: [] },
      spawn: { allow: ['**'], deny: [] },
    },
    rules: [
      { operation: 'read', effect: 'allow', zone: '**', line: null },
      { operation: 'write', effect: 'allow', zone: '**', line: null },
      { operation: 'spawn', effect: 'allow', zone: '**', line: null },
    ],
    projectedPolicy: normalizeRegionPolicy('unsandboxed'),
    compiledFrom: 'grandfather-infill-bound',
  }
}

function parseJsonField(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function pathInside(child, parent) {
  if (!child || !parent) return false
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(`${p}${path.sep}`)
}

function projectForAgent(agent, projects = []) {
  const cwd = agent?.cwd
  if (!cwd) return null
  return projects.find(project => project?.sourceDir && pathInside(cwd, project.sourceDir)) || null
}

function fleetAgentsForGrandfatherInfill(fleetDbPath) {
  if (!fs.existsSync(fleetDbPath)) return []
  const db = new Database(fleetDbPath, { readonly: true })
  try {
    return db.prepare(`
      SELECT id, friendly_name, cwd, metadata, machine_id
      FROM agents
      WHERE dead = 0 AND human = 0
      ORDER BY id
    `).all().map(row => ({
      ...row,
      metadata: parseJsonField(row.metadata, {}),
    }))
  } finally {
    db.close()
  }
}

export class PermissionLedger {
  constructor(dbPath) {
    this.file = dbPath
    this.dbPath = dbPath
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS permission_grants (
        id TEXT PRIMARY KEY,
        spawn_policy TEXT NOT NULL,
        permission_set TEXT,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_permission_grants_updated_at
        ON permission_grants(updated_at);
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
      SELECT id, spawn_policy, permission_set, updated_at, source
      FROM permission_grants
      WHERE id = ?
    `)
    this._upsert = this.db.prepare(`
      INSERT INTO permission_grants (id, spawn_policy, permission_set, updated_at, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        spawn_policy = excluded.spawn_policy,
        permission_set = excluded.permission_set,
        updated_at = excluded.updated_at,
        source = excluded.source
    `)
    this._delete = this.db.prepare('DELETE FROM permission_grants WHERE id = ?')
    this._worker = null
    this._nextRequestId = 1
    this._pending = new Map()
    this.migrateLegacyYamlIfNeeded()
  }

  migrateLegacyYamlIfNeeded() {
    if (this._metaGet.get(YAML_MIGRATION_META_KEY)) return { skipped: true, imported: 0 }
    const legacyFile = path.join(path.dirname(this.dbPath), 'daemon-permissions.yaml')
    if (!fs.existsSync(legacyFile)) {
      this._metaSet.run(YAML_MIGRATION_META_KEY, JSON.stringify({ imported: 0, file: legacyFile, missing: true }), nowIso())
      return { skipped: false, imported: 0 }
    }
    const parsed = readYamlFile(legacyFile, 'legacy daemon permission ledger')
    const agents = normalizeLegacyLedgerAgents(parsed)
    let imported = 0
    const importOne = this.db.transaction(() => {
      for (const [id, sourceRow] of Object.entries(agents)) {
        if (!id || !sourceRow || typeof sourceRow !== 'object') continue
        const grant = normalizeLedgerGrant(sourceRow)
        const row = this.rowFor(id, {
          spawnPolicy: grant.spawnPolicy,
          permissionSet: grant.permissionSet,
          source: sourceRow.source || 'migration:daemon-permissions-yaml',
        })
        this._upsert.run(
          row.id,
          JSON.stringify(row.spawnPolicy),
          row.permissionSet ? JSON.stringify(row.permissionSet) : null,
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
      ...(row.permission_set ? { permissionSet: JSON.parse(row.permission_set) } : {}),
    }
    const grant = normalizeLedgerGrant(parsed)
    return {
      id: row.id,
      spawnPolicy: grant.spawnPolicy,
      permissionSet: grant.permissionSet,
      updatedAt: row.updated_at,
      source: row.source || 'ledger',
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

  rowFor(id, { spawnPolicy, permissionSet, source = 'spawn' } = {}) {
    const key = String(id || '').trim()
    if (!key) throw new Error('cannot persist daemon permission grant without fleet id')
    const policy = normalizeRegionPolicy(spawnPolicy, 'cwd')
    return {
      id: key,
      spawnPolicy: policy,
      permissionSet: permissionSet || (isNoneGrant(spawnPolicy)
        ? emptyPermissionSet({ name: policy.name, projectedPolicy: policy })
        : null),
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
          && row.spawn_policy === expected.spawnPolicy
          && row.permission_set === expected.permissionSet
          && row.updated_at === expected.updatedAt
          && row.source === expected.source
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
        spawnPolicy: JSON.stringify(row.spawnPolicy),
        permissionSet: row.permissionSet ? JSON.stringify(row.permissionSet) : null,
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
    return this.setSync(id, options)
  }

  setSync(id, options = {}) {
    const row = this.rowFor(id, options)
    this._upsert.run(
      row.id,
      JSON.stringify(row.spawnPolicy),
      row.permissionSet ? JSON.stringify(row.permissionSet) : null,
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
  return null
}

// Resolve the daemon config an agent in `cwd` sees: the base config deep-joined
// with its project's `.tlda-daemon.yaml`, the project's values overwriting (like a
// git config local override, or a DB join with the project row winning).
export function readDaemonConfigForCwd(cwd, file = defaultDaemonConfigPath()) {
  const base = readDaemonConfig(file)
  const overridePath = projectDaemonOverridePath(cwd)
  if (!overridePath) return base
  const override = normalizeDaemonConfig(readYamlFile(overridePath, 'project daemon override'))
  return joinConfigs(base, override)
}

export function withDaemonModelAliases(config = {}, daemonConfig = {}) {
  const daemonModels = daemonConfig?.models && typeof daemonConfig.models === 'object' && !Array.isArray(daemonConfig.models)
    ? daemonConfig.models
    : {}
  const daemonProfiles = daemonConfig?.profiles && typeof daemonConfig.profiles === 'object' && !Array.isArray(daemonConfig.profiles)
    ? daemonConfig.profiles
    : {}
  if (!Object.keys(daemonModels).length && !Object.keys(daemonProfiles).length) return config || {}
  const { aliases, modelCeilings, harnessOptions } = normalizeDaemonModelRows(daemonModels)
  const nextSpawnPolicy = {
    ...((config || {}).spawnPolicy || {}),
    ...(Object.keys(daemonProfiles).length ? {
      permissionProfiles: {
        ...(((config || {}).spawnPolicy || {}).permissionProfiles || {}),
        ...daemonProfiles,
      },
      fenceEnabled: true,
    } : {}),
    ...(Object.keys(modelCeilings).length ? {
      modelCeilings: {
        ...(((config || {}).spawnPolicy || {}).modelCeilings || {}),
        ...modelCeilings,
      },
    } : {}),
  }
  return {
    ...(config || {}),
    ...(Object.keys(aliases).length ? { models: aliases } : {}),
    ...(Object.keys(harnessOptions).length ? { harnessOptions } : {}),
    spawnPolicy: nextSpawnPolicy,
  }
}

export function applyDaemonGrants(ledger, daemonConfig = {}) {
  const grants = daemonConfig?.grants && typeof daemonConfig.grants === 'object' && !Array.isArray(daemonConfig.grants)
    ? daemonConfig.grants
    : {}
  const profiles = daemonConfig?.profiles && typeof daemonConfig.profiles === 'object' && !Array.isArray(daemonConfig.profiles)
    ? daemonConfig.profiles
    : {}
  let written = 0
  for (const [id, value] of Object.entries(grants)) {
    const profileName = typeof value === 'string' ? value.trim().toLowerCase() : null
    const source = profileName ? profiles[profileName] : value
    if (!source) throw new Error(`daemon grant for ${id} references unknown profile "${value}"`)
    const grant = normalizeLedgerGrant(profileName ? { permissionSet: source } : source)
    ledger.setSync(id, {
      spawnPolicy: grant.spawnPolicy,
      permissionSet: grant.permissionSet,
      source: 'daemon.yaml:grants',
    })
    written++
  }
  return { written }
}

export function applyGrandfatherInfill(ledger, { fleetDbPath, config = {}, projects = [] } = {}) {
  if (!fleetDbPath) return { considered: 0, written: 0, skippedExisting: 0 }
  const agents = fleetAgentsForGrandfatherInfill(fleetDbPath)
  let written = 0
  let skippedExisting = 0
  for (const agent of agents) {
    if (!agent.id) continue
    if (ledger.get(agent.id)) {
      skippedExisting++
      continue
    }
    const project = projectForAgent(agent, projects)
    const metadata = agent.metadata || {}
    const grant = resolveSpawnGrant({
      spawnerPolicy: 'full',
      spawnerPermissionSet: allPermissionSet('grandfather-root-bound'),
      model: metadata.model || undefined,
      kind: metadata.kind || undefined,
      config,
      project,
      cwd: agent.cwd || undefined,
    })
    ledger.setSync(agent.id, {
      spawnPolicy: grant.grantedPolicy,
      permissionSet: grant.grantedPermissionSet,
      source: 'grandfather:fleet-db-cutover',
    })
    written++
  }
  return { considered: agents.length, written, skippedExisting }
}

export function defaultPermissionLedgerPath(configDir = path.join(os.homedir(), '.config', 'tlda')) {
  return path.join(configDir, 'fleet-daemon.db')
}

export function defaultDaemonConfigPath(configDir = path.join(os.homedir(), '.config', 'tlda')) {
  return path.join(configDir, 'daemon.yaml')
}

export function permissionLedgerPathFromDaemonConfig(daemonConfig = {}, configDir = path.join(os.homedir(), '.config', 'tlda')) {
  return defaultPermissionLedgerPath(configDir)
}

export function createPermissionLedger(file = defaultPermissionLedgerPath()) {
  return new PermissionLedger(file)
}
