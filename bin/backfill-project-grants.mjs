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
} from './lib/spawn/permission-ledger.mjs'
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
const rows = ro.prepare('SELECT id, cwd, session_kind FROM permission_grants').all()
ro.close()

// Act AS the localhost pseudo-agent: seed the daemon-config grants (incl. localhost)
// into the ledger, then read localhost's grant and spawn every agent under it.
const ledger = createPermissionLedger(ledgerPath)
if (APPLY) applyDaemonGrants(ledger, daemonConfig)  // ensure localhost + config grants are seeded before writing
const localhost = ledger.get('localhost')
if (!localhost) throw new Error('localhost pseudo-agent is not granted in the ledger; add `localhost: <profile>` to daemon.yaml grants and restart the daemon')

const byProfile = {}
let considered = 0, changed = 0, skippedNoProject = 0, skippedNoCwd = 0
const sample = []

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
  const gp = grant.grantedPolicy
  const wa = grant.grantedPermissionSet?.operations?.write?.allow || []
  const machineWide = wa.some((z) => ['**', 'machine', '/'].includes(z))
  byProfile[projectDefault] = (byProfile[projectDefault] || 0) + 1
  if (sample.length < 6) sample.push({ id: row.id, cwd: row.cwd, projectDefault, granted: gp?.name, machineWide })
  if (APPLY) {
    ledger.setSync(row.id, { spawnPolicy: gp, permissionSet: grant.grantedPermissionSet, source: 'backfill:project-default' })
  }
  changed++
}

console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY-RUN', considered, changed, skippedNoProject, skippedNoCwd, byProfile, sample }, null, 2))
ledger.close()
