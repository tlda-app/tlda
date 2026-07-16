#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  defaultDaemonConfigPath,
  permissionLedgerPathFromDaemonConfig,
  readDaemonConfig,
  readDaemonConfigForCwd,
  withDaemonModelAliases,
} from '../agent-launch/permission-ledger.mjs'
import { permissionSetLte } from '../server/lib/spawn-policy.mjs'

const __filename = fileURLToPath(import.meta.url)

function usage() {
  return `Usage: node bin/backfill-permission-profiles.mjs [--apply] [--config-dir DIR] [--db PATH] [--roster-db PATH] [--roster-json PATH] [--backup-dir DIR] [--json]

Dry-run is the default. It opens the ledger read-only and reports how many NULL
permission_profile rows can be filled by exactly one configured-profile match or
by the immutable local-agent recipe whose configured profile exactly equals the
grant's stored permission set.

Apply mode, when separately authorized, first copies db/wal/shm files to
BACKUP-DIR, then fills only rows classified as unique-set resolved or
recipe-disambiguated. It is idempotent: a post-apply dry-run should report no
would-update rows.
`
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    apply: false,
    configDir: process.env.TLDA_DAEMON_CONFIG_DIR || path.join(os.homedir(), '.config', 'tlda'),
    backupDir: null,
    dbPath: null,
    rosterDbPath: null,
    rosterJsonPath: null,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--config-dir') out.configDir = argv[++i]
    else if (arg === '--db') out.dbPath = argv[++i]
    else if (arg === '--roster-db') out.rosterDbPath = argv[++i]
    else if (arg === '--roster-json') out.rosterJsonPath = argv[++i]
    else if (arg === '--backup-dir') out.backupDir = argv[++i]
    else throw new Error(`unknown argument "${arg}"`)
  }
  return out
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function parseJson(value) {
  if (value == null || value === '') return null
  return JSON.parse(value)
}

function tryParseJson(value) {
  try {
    return parseJson(value)
  } catch {
    return null
  }
}

function expandPath(value) {
  if (!value) return null
  const text = String(value)
  if (text === '~') return os.homedir()
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2))
  return text
}

function operationSkeleton() {
  return {
    read: { allow: [], deny: [] },
    write: { allow: [], deny: [] },
    spawn: { allow: [], deny: [] },
  }
}

function materializeZone(zone, cwd) {
  const raw = String(zone || '').trim()
  if (!raw) return null
  if (raw === 'cwd') return cwd ? `${path.resolve(cwd)}/**` : raw
  if (raw === '**') return raw
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

function materializePermissionSet(set, cwd) {
  if (!set || typeof set !== 'object') return set
  const operations = operationSkeleton()
  for (const operation of Object.keys(operations)) {
    for (const effect of ['allow', 'deny']) {
      for (const zone of set.operations?.[operation]?.[effect] || []) {
        const materialized = materializeZone(zone, cwd)
        if (materialized) operations[operation][effect].push(materialized)
      }
    }
  }
  return { ...set, operations }
}

function configuredProfilesForRow(row, { configDir, daemonYaml, baseConfig }) {
  const daemonConfig = row.cwd
    ? readDaemonConfigForCwd(row.cwd, daemonYaml)
    : readDaemonConfig(daemonYaml)
  const config = withDaemonModelAliases(baseConfig, daemonConfig)
  const profiles = config?.spawnPolicy?.permissionProfiles || {}
  return Object.entries(profiles)
    .filter(([, profile]) => profile?.type === 'permission-set' && profile.operations)
    .map(([name, profile]) => [name, materializePermissionSet(profile, row.cwd)])
}

function configuredProfileMapForRow(row, context) {
  return new Map(configuredProfilesForRow(row, context))
}

export function exactProfileMatches(permissionSet, row, context) {
  if (!permissionSet) return []
  const matches = []
  for (const [name, profile] of configuredProfilesForRow(row, context)) {
    if (permissionSetLte(permissionSet, profile) && permissionSetLte(profile, permissionSet)) {
      matches.push(name)
    }
  }
  return matches
}

function emptyReport() {
  const samples = {
    alreadySet: [],
    uniqueSetResolved: [],
    recipeDisambiguated: [],
    missingRecipe: [],
    malformedJunkIdentity: [],
    unconfiguredRecipeProfile: [],
    setProfileConflict: [],
    stillAmbiguous: [],
  }
  return {
    total: 0,
    wouldUpdate: 0,
    alreadySet: 0,
    uniqueSetResolved: 0,
    recipeDisambiguated: 0,
    missingRecipe: 0,
    malformedJunkIdentity: 0,
    unconfiguredRecipeProfile: 0,
    setProfileConflict: 0,
    stillAmbiguous: 0,
    samples,
    rows: [],
  }
}

function addSample(samples, key, value, limit = 10) {
  if (samples[key].length < limit) samples[key].push(value)
}

function ensurePermissionProfileColumn(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(permission_grants)').all().map((row) => row.name))
  if (columns.has('permission_profile')) return false
  db.exec('ALTER TABLE permission_grants ADD COLUMN permission_profile TEXT')
  return true
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set()
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
}

function readLocalRecipeIndex(db) {
  const localColumns = tableColumns(db, 'local_agents')
  const recipeColumns = tableColumns(db, 'local_agent_process_recipes')
  const conversationColumns = tableColumns(db, 'local_agent_conversations')
  if (!localColumns.has('local_agent_id') || !recipeColumns.has('local_agent_id')) {
    return { byGrantId: new Map(), totalLocalAgents: 0, totalRecipes: 0 }
  }
  const hasConversations = conversationColumns.has('local_agent_id')
  const rows = db.prepare(`
    SELECT
      la.local_agent_id AS localAgentId,
      la.server_agent_id AS serverAgentId,
      la.friendly_name AS localFriendlyName,
      la.created_at AS localCreatedAt,
      la.bound_at AS localBoundAt,
      recipe.tmux_name AS recipeTmuxName,
      recipe.cwd AS recipeCwd,
      recipe.permission_profile AS recipePermissionProfile
      ${hasConversations ? `,
      convo.session_id AS conversationSessionId,
      convo.harness AS conversationHarness,
      convo.model AS conversationModel` : ''}
    FROM local_agents la
    LEFT JOIN local_agent_process_recipes recipe
      ON recipe.local_agent_id = la.local_agent_id
    ${hasConversations ? `LEFT JOIN local_agent_conversations convo
      ON convo.local_agent_id = la.local_agent_id` : ''}
    ORDER BY la.local_agent_id
  `).all()
  const byGrantId = new Map()
  for (const row of rows) {
    const entry = {
      localAgentId: row.localAgentId || null,
      serverAgentId: row.serverAgentId || null,
      friendlyName: row.localFriendlyName || null,
      createdAt: row.localCreatedAt || null,
      boundAt: row.localBoundAt || null,
      permissionProfile: row.recipePermissionProfile || null,
      tmuxName: row.recipeTmuxName || null,
      cwd: row.recipeCwd || null,
      sessionId: row.conversationSessionId || null,
      harness: row.conversationHarness || null,
      model: row.conversationModel || null,
    }
    for (const key of [entry.localAgentId, entry.serverAgentId]) {
      if (!key) continue
      if (!byGrantId.has(key)) byGrantId.set(key, [])
      byGrantId.get(key).push(entry)
    }
  }
  return {
    byGrantId,
    totalLocalAgents: rows.length,
    totalRecipes: rows.filter((row) => row.recipePermissionProfile).length,
  }
}

function defaultRosterDbPath(configDir, baseConfig) {
  const configured = expandPath(baseConfig?.mdVersions?.fleetDb)
  if (configured && fs.existsSync(configured)) return configured
  const legacy = path.join(configDir, 'fleet.db')
  if (fs.existsSync(legacy)) return legacy
  return null
}

function readRosterIndex(rosterDbPath) {
  const expanded = expandPath(rosterDbPath)
  if (!expanded || !fs.existsSync(expanded)) return { path: expanded, byId: new Map(), available: false }
  const db = new Database(expanded, { readonly: true, fileMustExist: true })
  try {
    const columns = tableColumns(db, 'agents')
    if (!columns.has('id')) return { path: expanded, byId: new Map(), available: false }
    const optional = [
      'friendly_name',
      'tmux_session',
      'session_id',
      'cwd',
      'last_seen',
      'dead',
      'human',
      'is_manager',
      'machine_id',
      'lineage_id',
      'phase',
      'last_active',
    ].filter((name) => columns.has(name))
    const rows = db.prepare(`SELECT id${optional.map((name) => `, ${name}`).join('')} FROM agents ORDER BY id`).all()
    const byId = new Map()
    for (const row of rows) {
      byId.set(row.id, {
        id: row.id,
        friendlyName: row.friendly_name || null,
        tmuxSession: row.tmux_session || null,
        sessionId: row.session_id || null,
        cwd: row.cwd || null,
        lastSeen: row.last_seen || null,
        lastActive: row.last_active || null,
        dead: row.dead == null ? null : !!row.dead,
        human: row.human == null ? null : !!row.human,
        manager: row.is_manager == null ? null : !!row.is_manager,
        machineId: row.machine_id || null,
        lineageId: row.lineage_id || null,
        phase: row.phase || null,
      })
    }
    return { path: expanded, byId, available: true, total: rows.length }
  } finally {
    db.close()
  }
}

function normalizeRosterRow(row) {
  return {
    id: row.id,
    friendlyName: row.friendly_name || row.name || null,
    tmuxSession: row.tmux_session || null,
    sessionId: row.session_id || null,
    cwd: row.cwd || null,
    lastSeen: row.last_seen || null,
    lastSeenAgoS: row.last_seen_ago_s == null ? null : row.last_seen_ago_s,
    lastActive: row.last_active || null,
    dead: row.dead == null ? (row.status === 'dead' ? true : null) : !!row.dead,
    human: row.human == null ? null : !!row.human,
    manager: row.is_manager == null ? null : !!row.is_manager,
    machineId: row.machine_id || null,
    envName: row.env_name || null,
    daemonKey: row.daemon_key || null,
    lineageId: row.lineage_id || null,
    phase: row.phase || null,
    status: row.status || null,
    model: row.model || null,
    inboxStatus: row.inbox_status || null,
  }
}

function readRosterJsonIndex(rosterJsonPath) {
  const expanded = expandPath(rosterJsonPath)
  if (!expanded || !fs.existsSync(expanded)) return { path: expanded, byId: new Map(), available: false }
  const payload = JSON.parse(fs.readFileSync(expanded, 'utf8'))
  const rows = Array.isArray(payload) ? payload : (payload.agents || [])
  const byId = new Map()
  for (const row of rows) {
    if (!row?.id) continue
    byId.set(row.id, normalizeRosterRow(row))
  }
  return { path: expanded, byId, available: true, total: rows.length }
}

function selectRows(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(permission_grants)').all().map((row) => row.name))
  const permissionProfileExpr = columns.has('permission_profile') ? 'permission_profile' : 'NULL AS permission_profile'
  const cwdExpr = columns.has('cwd') ? 'cwd' : 'NULL AS cwd'
  const optional = [
    'friendly_name',
    'session_id',
    'session_kind',
    'session_path',
    'last_seen',
    'tmux_session',
    'model',
    'machine_id',
    'env_name',
    'daemon_key',
  ]
    .map((name) => columns.has(name) ? name : `NULL AS ${name}`)
    .join(', ')
  return db.prepare(`
    SELECT id, spawn_policy, ${permissionProfileExpr}, permission_set, ${cwdExpr}, ${optional}
    FROM permission_grants
    ORDER BY id
  `).all()
}

function validIdentity(id) {
  const text = String(id || '')
  if (text.startsWith('fleet:')) return /^fleet:[A-Za-z0-9_.-]+$/.test(text)
  if (text.startsWith('local:')) return /^local:[0-9a-fA-F-]{36}$/.test(text)
  return false
}

function categoryInfo(category) {
  return {
    'already-set': { key: 'alreadySet', update: false },
    'unique-set resolved': { key: 'uniqueSetResolved', update: true },
    'recipe-disambiguated': { key: 'recipeDisambiguated', update: true },
    'missing recipe': { key: 'missingRecipe', update: false },
    'malformed/junk identity': { key: 'malformedJunkIdentity', update: false },
    'unconfigured recipe profile': { key: 'unconfiguredRecipeProfile', update: false },
    'set/profile conflict': { key: 'setProfileConflict', update: false },
    'still ambiguous': { key: 'stillAmbiguous', update: false },
  }[category]
}

function durableGrantEvidence(row, localRecipes, rosterRow) {
  return {
    grant: {
      friendlyName: row.friendly_name || null,
      sessionId: row.session_id || null,
      sessionKind: row.session_kind || null,
      sessionPath: row.session_path || null,
      tmuxSession: row.tmux_session || null,
      model: row.model || null,
      machineId: row.machine_id || null,
      envName: row.env_name || null,
      daemonKey: row.daemon_key || null,
      lastSeen: row.last_seen || null,
    },
    localAgents: localRecipes.map((entry) => ({
      localAgentId: entry.localAgentId,
      serverAgentId: entry.serverAgentId,
      permissionProfile: entry.permissionProfile,
      tmuxName: entry.tmuxName,
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      harness: entry.harness,
      model: entry.model,
    })),
    roster: rosterRow || null,
  }
}

function classifyRow(row, context) {
  const permissionSet = tryParseJson(row.permission_set)
  const current = String(row.permission_profile || '').trim()
  const matches = exactProfileMatches(permissionSet, row, context)
  const configuredProfiles = configuredProfileMapForRow(row, context)
  const localRecipes = context.recipeIndex?.byGrantId?.get(row.id) || []
  const rosterRow = context.rosterIndex?.byId?.get(row.id) || null
  const recipeProfiles = [...new Set(localRecipes.map((entry) => entry.permissionProfile).filter(Boolean))]
  const item = {
    id: row.id,
    cwd: row.cwd || null,
    current: current || null,
    matches,
    recipeProfiles,
    category: null,
    permissionProfile: null,
    reason: null,
    evidence: durableGrantEvidence(row, localRecipes, rosterRow),
  }

  if (current) {
    if (matches.includes(current)) {
      return { ...item, category: 'already-set', permissionProfile: current, reason: 'existing permission_profile exactly matches the stored permission_set' }
    }
    return { ...item, category: 'set/profile conflict', reason: 'existing permission_profile does not equal the stored permission_set' }
  }

  if (!validIdentity(row.id)) {
    return { ...item, category: 'malformed/junk identity', reason: 'grant id is not a valid fleet/local seat identity; left untouched' }
  }

  if (localRecipes.length) {
    if (localRecipes.length > 1 && recipeProfiles.length !== 1) {
      return { ...item, category: 'still ambiguous', reason: 'immutable local-agent key maps to multiple recipe profiles' }
    }

    const recipeProfile = recipeProfiles[0] || null
    if (!recipeProfile) {
      return { ...item, category: 'missing recipe', reason: 'durable local-agent recipe has no permission_profile' }
    }

    const configuredProfile = configuredProfiles.get(recipeProfile)
    if (!configuredProfile) {
      return { ...item, category: 'unconfigured recipe profile', permissionProfile: recipeProfile, reason: 'recipe permission_profile is not configured for this row' }
    }

    if (!permissionSet || !(permissionSetLte(permissionSet, configuredProfile) && permissionSetLte(configuredProfile, permissionSet))) {
      return { ...item, category: 'set/profile conflict', permissionProfile: recipeProfile, reason: 'recipe permission_profile does not exactly equal the stored permission_set' }
    }

    if (matches.length === 1) {
      return { ...item, category: 'unique-set resolved', permissionProfile: matches[0], reason: 'stored permission_set equals exactly one configured profile and the durable recipe agrees' }
    }
    if (matches.includes(recipeProfile)) {
      return { ...item, category: 'recipe-disambiguated', permissionProfile: recipeProfile, reason: 'immutable recipe profile is configured and exactly equals the stored permission_set' }
    }
    return { ...item, category: 'still ambiguous', permissionProfile: recipeProfile, reason: 'recipe profile equals the stored set but does not resolve configured profile ambiguity' }
  }

  if (matches.length === 1) {
    return { ...item, category: 'unique-set resolved', permissionProfile: matches[0], reason: 'stored permission_set equals exactly one configured profile' }
  }

  return { ...item, category: 'missing recipe', reason: 'legitimate identity has no durable local-agent recipe keyed by local_agent_id/server_agent_id' }
}

export function analyzeRows(rows, context) {
  const report = emptyReport()
  const updates = []
  for (const row of rows) {
    report.total++
    const item = classifyRow(row, context)
    const info = categoryInfo(item.category)
    report[info.key]++
    report.rows.push(item)
    addSample(report.samples, info.key, item)
    if (info.update) {
      report.wouldUpdate++
      updates.push({ id: row.id, permissionProfile: item.permissionProfile })
    }
  }
  return { report, updates }
}

function copyIfExists(file, backupDir) {
  if (!fs.existsSync(file)) return null
  const target = path.join(backupDir, path.basename(file))
  fs.copyFileSync(file, target)
  return { source: file, backup: target, bytes: fs.statSync(target).size }
}

function backupLedger(dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true })
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .map((file) => copyIfExists(file, backupDir))
    .filter(Boolean)
}

function revertProcedure(backups) {
  if (!backups?.length) return []
  return [
    'Stop the fleet daemon before restoring these files.',
    ...backups.map((entry) => `cp ${JSON.stringify(entry.backup)} ${JSON.stringify(entry.source)}`),
    'Restart the fleet daemon and run PRAGMA quick_check plus a dry-run expecting the pre-apply counts.',
  ]
}

export function runMigration({
  apply = false,
  configDir = process.env.TLDA_DAEMON_CONFIG_DIR || path.join(os.homedir(), '.config', 'tlda'),
  dbPath = null,
  rosterDbPath = null,
  rosterJsonPath = null,
  backupDir = null,
} = {}) {
  const daemonYaml = defaultDaemonConfigPath(configDir)
  const daemonConfig = readDaemonConfig(daemonYaml)
  const ledgerPath = dbPath || permissionLedgerPathFromDaemonConfig(daemonConfig, configDir)
  const baseConfig = readJsonIfExists(path.join(configDir, 'config.json'))
  const db = new Database(ledgerPath, apply ? {} : { readonly: true, fileMustExist: true })
  let backups = []
  let addedColumn = false
  let applyResult = null
  try {
    if (apply) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const finalBackupDir = backupDir || path.join(configDir, 'permission-profile-backups', stamp)
      backups = backupLedger(ledgerPath, finalBackupDir)
      addedColumn = ensurePermissionProfileColumn(db)
    }
    const recipeIndex = readLocalRecipeIndex(db)
    const rosterIndex = rosterJsonPath
      ? readRosterJsonIndex(rosterJsonPath)
      : readRosterIndex(rosterDbPath || defaultRosterDbPath(configDir, baseConfig))
    const context = { configDir, daemonYaml, baseConfig, recipeIndex, rosterIndex }
    const beforeRows = selectRows(db)
    const { report, updates } = analyzeRows(beforeRows, context)
    if (!apply) {
      return {
        mode: 'dry-run',
        ledgerPath,
        rosterPath: rosterIndex.path || null,
        recipeIndex: {
          totalLocalAgents: recipeIndex.totalLocalAgents,
          totalRecipes: recipeIndex.totalRecipes,
        },
        report,
        backupRequiredForApply: ['db', 'wal', 'shm'],
        applyVerification: [
          'PRAGMA quick_check returns ok',
          'updated row count equals dry-run wouldUpdate count',
          'post-apply dry-run reports wouldUpdate=0',
        ],
        revertProcedure: ['Apply mode prints exact backup paths and copy commands.'],
      }
    }

    const update = db.prepare('UPDATE permission_grants SET permission_profile = ? WHERE id = ? AND (permission_profile IS NULL OR permission_profile = ?)')
    const tx = db.transaction(() => {
      for (const row of updates) update.run(row.permissionProfile, row.id, '')
    })
    tx()
    const quickCheck = db.prepare('PRAGMA quick_check').pluck().get()
    const afterRows = selectRows(db)
    const { report: postApplyDryRun } = analyzeRows(afterRows, context)
    applyResult = {
      addedColumn,
      updated: updates.length,
      quickCheck,
      postApplyDryRun,
    }
    return {
      mode: 'apply',
      ledgerPath,
      report,
      backups,
      apply: applyResult,
      revertProcedure: revertProcedure(backups),
    }
  } finally {
    db.close()
  }
}

if (process.argv[1] === __filename) {
  try {
    const opts = parseArgs()
    if (opts.help) {
      console.log(usage())
      process.exit(0)
    }
    const result = runMigration(opts)
    console.log(JSON.stringify(result, null, 2))
  } catch (e) {
    console.error(e?.stack || e?.message || String(e))
    process.exit(1)
  }
}
