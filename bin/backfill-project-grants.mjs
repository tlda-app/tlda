#!/usr/bin/env node
// Backfill existing ledger grants to each agent's PROJECT default profile, using the
// git-style project cascade (.tlda-daemon.yaml joined over the base daemon config).
//
// Existing agents hold stale grants scoped to their cwd, so their spawns stay caged
// even though their project (e.g. tlda) defaults to app-dev. This re-grants each agent
// whose cwd is inside a project that declares a `default` profile. The authority for
// the re-grant is `localhost` — a pseudo-agent granted in the daemon config; this local
// process acts AS localhost through the normal spawn path (no special-cased authority).
// Agents whose cwd is not in a project with a `.tlda-daemon.yaml default` are LEFT
// UNTOUCHED.
//
// Usage:  node bin/backfill-project-grants.mjs [--apply]   (default: dry-run)
// --apply writes only rows whose target project-default grant is a strict raise
// over the current grant. Narrowing broad grants is a separate policy decision,
// not part of the un-cage repair.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import {
  createPermissionLedger,
  permissionLedgerPathFromDaemonConfig,
  readDaemonConfig,
  readDaemonConfigForCwd,
  withDaemonModelAliases,
  defaultDaemonConfigPath,
  applyDaemonGrants,
} from '../agent-launch/permission-ledger.mjs'
import { resolveSpawnGrant } from '../server/lib/spawn-policy.mjs'

const APPLY = process.argv.includes('--apply')
const CONFIG_DIR = path.join(os.homedir(), '.config', 'tlda')
const daemonYaml = defaultDaemonConfigPath(CONFIG_DIR)

const cfgJson = fs.existsSync(path.join(CONFIG_DIR, 'config.json'))
  ? JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'))
  : {}
const daemonConfig = readDaemonConfig(daemonYaml)
const ledgerPath = permissionLedgerPathFromDaemonConfig(daemonConfig, CONFIG_DIR)

// Read (id, cwd, session_kind) for every grant row directly — the ledger's get()
// exposes neither cwd nor the agent's kind. The KIND is load-bearing: without it the
// model ceiling resolves to the narrow (cwd) tier and clamps every agent to its
// folder, overriding the project profile. An agent's kind is always known (it's the
// harness it runs), so we pass it through to the grant math.
function assertLedgerColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(permission_grants)').all().map((row) => row.name))
  for (const name of ['id', 'cwd', 'session_kind']) {
    if (!columns.has(name)) {
      throw new Error(`permission ledger ${ledgerPath} is missing required column "${name}"; run this with the fleet daemon's current ledger schema`)
    }
  }
}

const ro = new Database(ledgerPath, { readonly: true })
assertLedgerColumns(ro)
const rows = ro.prepare('SELECT id, cwd, session_kind, spawn_policy, permission_set FROM permission_grants').all()
ro.close()

// Act AS the localhost pseudo-agent: seed the daemon-config grants (incl. localhost)
// into the ledger, then read localhost's grant and spawn every agent under it.
const ledger = createPermissionLedger(ledgerPath)
if (APPLY) applyDaemonGrants(ledger, daemonConfig)  // ensure localhost + config grants are seeded before writing
const localhost = ledger.get('localhost')
if (!localhost) throw new Error('localhost pseudo-agent is not granted in the ledger; add `localhost: <profile>` to daemon.yaml grants and restart the daemon')

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function zones(set, operation, effect) {
  return (set?.operations?.[operation]?.[effect] || [])
    .map((zone) => String(zone || '').trim())
    .filter(Boolean)
}

function globRoot(zone) {
  const raw = String(zone || '').trim()
  if (raw === '**' || raw === '/' || raw === '/**') return { universal: true, root: raw }
  const root = raw.endsWith('/**') ? raw.slice(0, -3) : raw
  return { universal: false, root }
}

function zoneCovers(covering, covered) {
  const a = globRoot(covering)
  const b = globRoot(covered)
  if (a.universal) return true
  if (b.universal) return false
  return a.root === b.root || b.root.startsWith(`${a.root}/`)
}

function coversAll(coveringZones, coveredZones) {
  return coveredZones.every((covered) => coveringZones.some((covering) => zoneCovers(covering, covered)))
}

function sameZones(a, b) {
  return coversAll(a, b) && coversAll(b, a)
}

function directionForGrant(currentSet, targetSet) {
  if (!currentSet || !targetSet) return 'unknown'
  const checks = []
  for (const operation of ['read', 'write', 'spawn']) {
    const currentAllow = zones(currentSet, operation, 'allow')
    const targetAllow = zones(targetSet, operation, 'allow')
    const currentDeny = zones(currentSet, operation, 'deny')
    const targetDeny = zones(targetSet, operation, 'deny')
    checks.push({
      same: sameZones(currentAllow, targetAllow) && sameZones(currentDeny, targetDeny),
      targetAtLeastAsBroad: coversAll(targetAllow, currentAllow) && coversAll(currentDeny, targetDeny),
      currentAtLeastAsBroad: coversAll(currentAllow, targetAllow) && coversAll(targetDeny, currentDeny),
    })
  }
  if (checks.every((check) => check.same)) return 'same'
  if (checks.every((check) => check.targetAtLeastAsBroad) && checks.some((check) => !check.same)) return 'raise'
  if (checks.every((check) => check.currentAtLeastAsBroad) && checks.some((check) => !check.same)) return 'narrow'
  return 'mixed'
}

const byProfile = {}
const byDirection = { raise: 0, narrow: 0, mixed: 0, same: 0, unknown: 0 }
let considered = 0, eligible = 0, changed = 0, skippedNoProject = 0, skippedNoCwd = 0
const sample = []
const directionSamples = { raise: [], narrow: [], mixed: [], same: [], unknown: [] }

for (const row of rows) {
  considered++
  if (!row.cwd) { skippedNoCwd++; continue }
  const daemonForCwd = readDaemonConfigForCwd(row.cwd, daemonYaml)
  const projectDefault = daemonForCwd?.default
  if (!projectDefault) { skippedNoProject++; continue }
  const grantConfig = withDaemonModelAliases(cfgJson, daemonForCwd)
  const grant = resolveSpawnGrant({
    spawnerPolicy: localhost.spawnPolicy,
    spawnerPermissionSet: localhost.permissionSet,
    kind: row.session_kind || undefined,
    config: grantConfig,
    cwd: row.cwd,
  })
  const gp = grant.spawnPolicy
  const wa = grant.permissionSet?.operations?.write?.allow || []
  const machineWide = wa.some((z) => ['**', 'machine', '/'].includes(z))
  const currentPermissionSet = parseJson(row.permission_set)
  const direction = directionForGrant(currentPermissionSet, grant.permissionSet)
  byDirection[direction] = (byDirection[direction] || 0) + 1
  eligible++
  byProfile[projectDefault] = (byProfile[projectDefault] || 0) + 1
  const item = { id: row.id, cwd: row.cwd, projectDefault, permissionProfile: grant.permissionProfile || null, machineWide, direction }
  if (sample.length < 6) sample.push(item)
  if (directionSamples[direction]?.length < 6) directionSamples[direction].push(item)
  if (APPLY && direction === 'raise') {
    ledger.setSync(row.id, { spawnPolicy: gp, permissionProfile: grant.permissionProfile, permissionSet: grant.permissionSet, source: 'backfill:project-default' })
    changed++
  }
}

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY_RAISE_ONLY' : 'DRY-RUN',
  considered,
  eligible,
  changed,
  skippedNoProject,
  skippedNoCwd,
  byProfile,
  byDirection,
  sample,
  directionSamples,
}, null, 2))
ledger.close()
