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
  return `Usage: node bin/backfill-permission-profiles.mjs [--apply] [--config-dir DIR] [--db PATH] [--backup-dir DIR] [--json]

Dry-run is the default. It opens the ledger read-only and reports how many NULL
permission_profile rows can be filled by exactly one configured-profile match.

Apply mode, when separately authorized, first copies db/wal/shm files to
BACKUP-DIR, then fills only NULL permission_profile rows with exactly one match.
It is idempotent: a post-apply dry-run should report resolved=0.
`
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    apply: false,
    configDir: process.env.TLDA_DAEMON_CONFIG_DIR || path.join(os.homedir(), '.config', 'tlda'),
    backupDir: null,
    dbPath: null,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--config-dir') out.configDir = argv[++i]
    else if (arg === '--db') out.dbPath = argv[++i]
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
  return {
    total: 0,
    resolved: 0,
    alreadySet: 0,
    unresolved: 0,
    ambiguous: 0,
    conflicting: 0,
    samples: {
      resolved: [],
      alreadySet: [],
      unresolved: [],
      ambiguous: [],
      conflicting: [],
    },
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

function selectRows(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(permission_grants)').all().map((row) => row.name))
  const permissionProfileExpr = columns.has('permission_profile') ? 'permission_profile' : 'NULL AS permission_profile'
  const cwdExpr = columns.has('cwd') ? 'cwd' : 'NULL AS cwd'
  return db.prepare(`
    SELECT id, spawn_policy, ${permissionProfileExpr}, permission_set, ${cwdExpr}
    FROM permission_grants
    ORDER BY id
  `).all()
}

export function analyzeRows(rows, context) {
  const report = emptyReport()
  const updates = []
  for (const row of rows) {
    report.total++
    const permissionSet = parseJson(row.permission_set)
    const current = String(row.permission_profile || '').trim()
    const matches = exactProfileMatches(permissionSet, row, context)
    const item = { id: row.id, cwd: row.cwd || null, current: current || null, matches }
    if (current) {
      if (matches.includes(current)) {
        report.alreadySet++
        addSample(report.samples, 'alreadySet', item)
      } else {
        report.conflicting++
        addSample(report.samples, 'conflicting', item)
      }
    } else if (matches.length === 1) {
      report.resolved++
      updates.push({ id: row.id, permissionProfile: matches[0] })
      addSample(report.samples, 'resolved', { ...item, permissionProfile: matches[0] })
    } else if (matches.length > 1) {
      report.ambiguous++
      addSample(report.samples, 'ambiguous', item)
    } else {
      report.unresolved++
      addSample(report.samples, 'unresolved', item)
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
  backupDir = null,
} = {}) {
  const daemonYaml = defaultDaemonConfigPath(configDir)
  const daemonConfig = readDaemonConfig(daemonYaml)
  const ledgerPath = dbPath || permissionLedgerPathFromDaemonConfig(daemonConfig, configDir)
  const baseConfig = readJsonIfExists(path.join(configDir, 'config.json'))
  const context = { configDir, daemonYaml, baseConfig }
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
    const beforeRows = selectRows(db)
    const { report, updates } = analyzeRows(beforeRows, context)
    if (!apply) {
      return {
        mode: 'dry-run',
        ledgerPath,
        report,
        backupRequiredForApply: ['db', 'wal', 'shm'],
        applyVerification: [
          'PRAGMA quick_check returns ok',
          'updated row count equals dry-run resolved count',
          'post-apply dry-run reports resolved=0',
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
