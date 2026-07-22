import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { Worker } from 'worker_threads'
import Database from 'better-sqlite3'
import YAML from 'yaml'
import {
  emptyPermissionSet,
  resolveSpawnGrant,
  normalizeRegionPolicy,
  regionScopeFromSet,
} from '../server/lib/spawn-policy.mjs'
import {
  validateDaemonConfigTopLevel,
  validateProjectDaemonOverrideTopLevel,
  validateStrictServers,
} from '../shared/daemon-config-schema.mjs'

function nowIso() {
  return new Date().toISOString()
}

function processBindingSignature(row = {}) {
  return JSON.stringify({
    id: row.id || null,
    sessionId: row.sessionId || null,
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
const YAML_MIGRATION_META_KEY = 'migration.daemon-permissions-yaml.v1'

// An explicit empty ('none') grant — confers nothing. Detected off the raw input so a
// stored 'none' still materializes as an empty permission set after the level strip.
function isNoneGrant(value) {
  if (value == null || value === '') return false
  const s = typeof value === 'string' ? value : (value.permission ?? value.policy ?? value.name ?? '')
  return String(s).trim().toLowerCase() === 'none'
}

function normalizeLedgerGrant(value) {
  if (!value) {
    throw new PermissionLedgerError('SPAWN_PERMISSION_LEDGER_MISSING_GRANT', 'permission ledger grant is required')
  }
  const rawPermissionSet = value.permissionSet || value.permissions || null
  if (rawPermissionSet) {
    const profileName = String(value.permissionProfile || '').trim()
    const scope = value.spawnPolicy
      ? normalizeRegionPolicy(value.spawnPolicy)
      : { policy: regionScopeFromSet(rawPermissionSet) }
    const spawnPolicy = {
      policy: scope.policy,
      ...(scope.network === false ? { network: false } : {}),
    }
    return {
      spawnPolicy,
      permissionProfile: profileName || null,
      ...(normalizePermissionIntersection(value.permissionIntersection) ? { permissionIntersection: normalizePermissionIntersection(value.permissionIntersection) } : {}),
      permissionSet: {
        ...rawPermissionSet,
        projectedPolicy: spawnPolicy,
      },
    }
  }
  const raw = value.spawnPolicy || value.policy || value.permission || value
  const spawnPolicy = normalizeRegionPolicy(raw)
  return {
    spawnPolicy,
    permissionProfile: null,
    ...(normalizePermissionIntersection(value.permissionIntersection) ? { permissionIntersection: normalizePermissionIntersection(value.permissionIntersection) } : {}),
    permissionSet: isNoneGrant(raw)
      ? emptyPermissionSet({ name: 'none', projectedPolicy: { ...spawnPolicy, permission: 'none' } })
      : null,
  }
}

function normalizePermissionIntersection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.map((name) => String(name || '').trim()).filter(Boolean)
    : []
  if (value.type !== 'permission-intersection' || profiles.length < 2) return null
  return {
    ...value,
    type: 'permission-intersection',
    profiles: [...new Set(profiles)],
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

function validateDaemonDefault(config = {}) {
  if (config.default && !(config.profiles || {})[config.default]) {
    throw new Error(`daemon default references unknown profile "${config.default}"`)
  }
  return config
}

function normalizeDaemonConfig(parsed, { validateDefault = true } = {}) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : parsed
  validateDaemonConfigTopLevel(root, 'daemon config')
  const models = root.models && typeof root.models === 'object' && !Array.isArray(root.models)
    ? root.models
    : {}
  const regions = normalizeDaemonRegions(root.regions)
  const profiles = normalizeDaemonProfiles(root.profiles, regions)
  const grants = root.grants && typeof root.grants === 'object' && !Array.isArray(root.grants)
    ? root.grants
    : {}
  const servers = validateStrictServers(root.servers)
  const defaultProfile = typeof root.default === 'string' && root.default.trim() ? root.default.trim() : null
  const defaultServer = typeof root.defaultServer === 'string' && root.defaultServer.trim() ? root.defaultServer.trim() : null
  if (typeof root.defaultServer !== 'string' || !root.defaultServer.trim()) {
    throw new Error('tlda config: "defaultServer" must be a nonempty string in daemon.yaml')
  }
  if (!servers[defaultServer]) {
    throw new Error(`tlda config: no server named "${defaultServer}" in daemon.yaml servers — known: ${Object.keys(servers).join(', ') || '(none)'}`)
  }
  const config = {
    regions,
    profiles,
    grants,
    models,
    servers,
    ...(defaultServer ? { defaultServer } : {}),
    ...(defaultProfile ? { default: defaultProfile } : {}),
  }
  return validateDefault ? validateDaemonDefault(config) : config
}

function normalizeProjectDaemonOverride(parsed) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : parsed
  validateProjectDaemonOverrideTopLevel(root, 'project daemon override')
  const models = root.models && typeof root.models === 'object' && !Array.isArray(root.models)
    ? root.models
    : {}
  const regions = normalizeDaemonRegions(root.regions)
  const profiles = normalizeDaemonProfiles(root.profiles, regions)
  const grants = root.grants && typeof root.grants === 'object' && !Array.isArray(root.grants)
    ? root.grants
    : {}
  const defaultProfile = typeof root.default === 'string' && root.default.trim() ? root.default.trim() : null
  return {
    regions,
    profiles,
    grants,
    models,
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
    const cap = row.cap || row.permission || row.spawnPolicy || row.model_cap || null
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

// Grant-eligible agents from an in-memory roster (the authoritative `msg.agents`
// the daemon receives). Never grant dead or human seats. This replaces the old
// local-`fleet.db` read, which was stale/incomplete (missed live agents that had
// never been written to the local db) — the roster is the complete source.
function normalizeGrandfatherAgents(agents = []) {
  if (!Array.isArray(agents)) return []
  return agents
    .filter(agent => agent && typeof agent === 'object')
    .filter(agent => !agent.dead && !agent.human)
    .map(agent => ({
      ...agent,
      metadata: typeof agent.metadata === 'string' ? parseJsonField(agent.metadata, {}) : (agent.metadata || {}),
    }))
}

// The fleet-standard grandfather grant: full spawn policy bounded to the agent's
// project/cwd region. This is the same derivation the ledger has always used for
// non-spawn-tracked seats — reused verbatim, no new grant shape.
export function resolveGrandfatherGrant(agent, { config = {}, projects = [] } = {}) {
  const project = projectForAgent(agent, projects)
  const metadata = agent.metadata || {}
  return resolveSpawnGrant({
    spawnerPermissionSet: allPermissionSet('grandfather-root-bound'),
    model: metadata.model || undefined,
    kind: metadata.kind || undefined,
    config,
    project,
    cwd: agent.cwd || undefined,
  })
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS permission_grants (
        id TEXT PRIMARY KEY,
        spawn_policy TEXT NOT NULL,
        permission_profile TEXT,
        permission_intersection TEXT,
        permission_set TEXT,
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
      CREATE TABLE IF NOT EXISTS ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_permission_grants_updated_at
        ON permission_grants(updated_at);
    `)
    for (const ddl of [
      'ALTER TABLE permission_grants ADD COLUMN friendly_name TEXT',
      'ALTER TABLE permission_grants ADD COLUMN permission_profile TEXT',
      'ALTER TABLE permission_grants ADD COLUMN permission_intersection TEXT',
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
      SELECT id, spawn_policy, permission_profile, permission_intersection, permission_set, updated_at, source,
        friendly_name, session_id, session_kind, session_path, tmux_session, model,
        machine_id, env_name, daemon_key, terminal_capability, cwd, last_seen
      FROM permission_grants
      WHERE id = ?
    `)
    this._findByFriendlyName = this.db.prepare(`
      SELECT id, spawn_policy, permission_profile, permission_intersection, permission_set, updated_at, source,
        friendly_name, session_id, session_kind, session_path, tmux_session, model,
        machine_id, env_name, daemon_key, terminal_capability, cwd, last_seen
      FROM permission_grants
      WHERE friendly_name = ?
      ORDER BY COALESCE(last_seen, updated_at) DESC
      LIMIT 1
    `)
    this._list = this.db.prepare(`
      SELECT id, spawn_policy, permission_profile, permission_intersection, permission_set, updated_at, source,
        friendly_name, session_id, session_kind, session_path, tmux_session, model,
        machine_id, env_name, daemon_key, terminal_capability, cwd, last_seen
      FROM permission_grants
      WHERE tmux_session IS NOT NULL
      ORDER BY id
    `)
    this._upsert = this.db.prepare(`
      INSERT INTO permission_grants (id, spawn_policy, permission_profile, permission_intersection, permission_set, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        spawn_policy = excluded.spawn_policy,
        permission_profile = excluded.permission_profile,
        permission_intersection = excluded.permission_intersection,
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
          permissionProfile: grant.permissionProfile,
          permissionIntersection: grant.permissionIntersection,
          permissionSet: grant.permissionSet,
          source: sourceRow.source || 'migration:daemon-permissions-yaml',
        })
        this._upsert.run(
          row.id,
          JSON.stringify(row.spawnPolicy),
          row.permissionProfile,
          row.permissionIntersection ? JSON.stringify(row.permissionIntersection) : null,
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
      spawnPolicy: JSON.parse(row.spawn_policy),
      permissionProfile: row.permission_profile || null,
      ...(row.permission_intersection ? { permissionIntersection: JSON.parse(row.permission_intersection) } : {}),
      ...(row.permission_set ? { permissionSet: JSON.parse(row.permission_set) } : {}),
    }
    const grant = normalizeLedgerGrant(parsed)
    return {
      id: row.id,
      spawnPolicy: grant.spawnPolicy,
      permissionProfile: grant.permissionProfile,
      ...(grant.permissionIntersection ? { permissionIntersection: grant.permissionIntersection } : {}),
      permissionSet: grant.permissionSet,
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

  rowFor(id, { spawnPolicy, permissionProfile = null, permissionIntersection = null, permissionSet, source = 'spawn' } = {}) {
    const key = String(id || '').trim()
    if (!key) throw new Error('cannot persist daemon permission grant without fleet id')
    const policy = normalizeRegionPolicy(spawnPolicy)
    return {
      id: key,
      spawnPolicy: policy,
      permissionProfile: permissionProfile || null,
      permissionIntersection: normalizePermissionIntersection(permissionIntersection),
      permissionSet: permissionSet || (isNoneGrant(spawnPolicy)
        ? emptyPermissionSet({ name: 'none', projectedPolicy: { ...policy, permission: 'none' } })
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
          && row.permission_profile === expected.permissionProfile
          && row.permission_intersection === expected.permissionIntersection
          && row.permission_set === expected.permissionSet
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
        spawnPolicy: JSON.stringify(row.spawnPolicy),
        permissionProfile: row.permissionProfile,
        permissionIntersection: row.permissionIntersection ? JSON.stringify(row.permissionIntersection) : null,
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
      JSON.stringify(row.spawnPolicy),
      row.permissionProfile,
      row.permissionIntersection ? JSON.stringify(row.permissionIntersection) : null,
      row.permissionSet ? JSON.stringify(row.permissionSet) : null,
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
    // Identity is the seat tuple. `model` and `cwd` are metadata, not
    // identity: a model ALIAS vs its resolved name ('fable' vs
    // 'claude-fable-5') bounced every wake of a healthy seat, and a worktree
    // cwd vs the repo root rejected legitimate worktree logins (both 7/17).
    // They still persist fill-null-only below; they just cannot conflict.
    const incoming = {
      sessionId,
      sessionKind,
      sessionPath,
      tmuxSession,
      machineId,
      envName,
      daemonKey,
    }
    for (const [field, value] of Object.entries(incoming)) {
      const normalized = value == null || value === '' ? null : String(value)
      const current = existing[field] == null || existing[field] === '' ? null : String(existing[field])
      if (normalized && current && normalized !== current) {
        throw new Error(`daemon ledger identity conflict for ${key}: ${field} existing=${current} incoming=${normalized}`)
      }
    }
    this.db.prepare(`
      UPDATE permission_grants SET
        session_id = COALESCE(session_id, ?),
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
      sessionId || null,
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
  const override = normalizeProjectDaemonOverride(readYamlFile(overridePath, 'project daemon override'))
  return validateDaemonDefault(joinConfigs(base, override))
}

export function withDaemonModelAliases(config = {}, daemonConfig = {}) {
  const daemonModels = daemonConfig?.models && typeof daemonConfig.models === 'object' && !Array.isArray(daemonConfig.models)
    ? daemonConfig.models
    : {}
  const daemonProfiles = daemonConfig?.profiles && typeof daemonConfig.profiles === 'object' && !Array.isArray(daemonConfig.profiles)
    ? daemonConfig.profiles
    : {}
  // No daemon models AND no daemon profiles: the daemon config contributes
  // nothing. Return an EMPTY, daemon-only policy — never the legacy `config`
  // (config.json is retired; leaking its spawn policy here is exactly the
  // fallback this migration removes). Fail closed: no profiles → no permission
  // profiles, not config.json's.
  if (!Object.keys(daemonModels).length && !Object.keys(daemonProfiles).length) return { spawnPolicy: {} }
  const { aliases, harnessOptions, modelSpecs, defaultModel } = normalizeDaemonModelRows(daemonModels)
  // config.json contributes nothing: the spawn policy, model aliases, specs, and
  // catalog are the daemon config's alone. No config.json base is spread in.
  const nextSpawnPolicy = {
    ...(Object.keys(daemonProfiles).length ? {
      permissionProfiles: { ...daemonProfiles },
      fenceEnabled: true,
      defaultProfile: daemonConfig.default || null,
    } : {}),
  }
  return {
    ...(Object.keys(modelSpecs).length ? { modelSpecs } : {}),
    ...(Object.keys(modelSpecs).length ? { modelCatalog: { default: defaultModel, values: modelSpecs } } : {}),
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
    const grant = normalizeLedgerGrant(profileName ? { permissionProfile: profileName, permissionSet: source } : source)
    ledger.setSync(id, {
      spawnPolicy: grant.spawnPolicy,
      permissionProfile: profileName,
      permissionIntersection: grant.permissionIntersection,
      permissionSet: grant.permissionSet,
      source: 'daemon.yaml:grants',
    })
    written++
  }
  return { written }
}

// Fill a missing permission-ledger grant for every eligible agent in `agents`
// (the authoritative roster). FILL-NULL-ONLY: writes only when `ledger.get(id)`
// is null — never overwrites or broadens an existing grant, so narrower
// spawn-derived grants are preserved and it is safe to run on every roster
// change. Idempotent: a second pass over the same roster is a no-op.
export function applyGrandfatherInfill(ledger, { agents = [], config = {}, projects = [] } = {}) {
  const eligible = normalizeGrandfatherAgents(agents)
  let written = 0
  let skippedExisting = 0
  for (const agent of eligible) {
    if (!agent.id) continue
    if (ledger.get(agent.id)) {
      skippedExisting++
      continue
    }
    const grant = resolveGrandfatherGrant(agent, { config, projects })
    ledger.setSync(agent.id, {
      spawnPolicy: grant.spawnPolicy,
      permissionProfile: grant.permissionProfile,
      permissionIntersection: grant.permissionIntersection,
      permissionSet: grant.permissionSet,
      source: 'grandfather:fleet-db-cutover',
    })
    written++
  }
  return { considered: eligible.length, written, skippedExisting }
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
