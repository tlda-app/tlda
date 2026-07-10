#!/usr/bin/env node
// One-time migration: recover missing/bad `fleet_id` on codex session-identity records.
//
// WHY THIS IS A ONE-TIME MIGRATION, NOT A STANDING FALLBACK (Skip, 2026-07-06):
// The durable fix is that the daemon records `fleet_id` from the owner it already
// holds. This migration only repairs records that were written null BEFORE that
// fix. It scans codex rollouts for their `Registered fleet:<id>` marker and writes
// recovered ids via the daemon's own store functions. It is invoked MANUALLY (never
// on every startup) so it cannot silently mask a regression in the durable write
// path — if a fresh missing/null identity appears after this, that is a real bug to
// surface, not something to auto-heal.
//
// SAFETY: run only while the fleet-daemon is STOPPED (the daemon is the sole writer
// of session-identity.json; a concurrent daemon save would clobber this write).
//
//   node scripts/migrate-codex-fleet-ids.mjs --dry-run [--file <path>]
//   node scripts/migrate-codex-fleet-ids.mjs           # writes the real store

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadSessionIdentityStore,
  saveSessionIdentityStore,
  sessionIdentityPath,
  upsertSessionIdentity,
} from '../bin/lib/session-identity-store.mjs'
import { scanFileIdentitySync } from '../bin/lib/daemon-jsonl-hot-path.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const fileArg = args.includes('--file') ? args[args.indexOf('--file') + 1] : null
const sessionsArg = args.includes('--sessions-dir') ? args[args.indexOf('--sessions-dir') + 1] : null
const storePath = fileArg || sessionIdentityPath()
const codexSessionsDir = sessionsArg || path.join(os.homedir(), '.codex', 'sessions')

const MARKER = /Registered\s+(fleet:[0-9a-f]{8})/
const VALID_ANY_FLEET_ID = /^fleet:[A-Za-z0-9_-]+$/

function ownerFromRollout(jsonlPath) {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return null
  try {
    // The registration marker is written near the top of the rollout; 512KB is
    // ample and avoids reading multi-MB transcripts in full.
    const fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.alloc(512 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const m = MARKER.exec(buf.subarray(0, n).toString('utf8'))
    return m ? m[1] : null
  } catch {
    return null
  }
}

// A valid fleet id is `fleet:` + an 8-hex handle. Null OR malformed (e.g. the
// truncated `fleet:` the live content-derivation bug writes) both make the
// fleet-id -> rollout resume lookup miss, so recover both.
const VALID_FLEET_ID = /^fleet:[0-9a-f]{8}$/
const store = loadSessionIdentityStore(storePath)
const codexNulls = Object.values(store.sessions).filter(
  r => r.harness_kind === 'codex' && !VALID_FLEET_ID.test(r.fleet_id || ''),
)

console.log(`store: ${storePath}`)
console.log(`codex records with null/malformed fleet_id: ${codexNulls.length}`)

let recovered = 0
const missed = []
for (const rec of codexNulls) {
  const owner = ownerFromRollout(rec.jsonl_path)
  if (!owner) {
    missed.push(rec.session_id)
    continue
  }
  const changed = upsertSessionIdentity(store, {
    session_id: rec.session_id,
    harness_kind: 'codex',
    fleet_id: owner,
  })
  if (changed) recovered++
  console.log(`  ${rec.session_id.slice(0, 22)} -> ${owner}${owner === 'fleet:c16d9c53' ? '  <== releast' : ''}`)
}

console.log(`\nrecovered: ${recovered}/${codexNulls.length}  (missed: ${missed.length})`)
if (missed.length) console.log('  missed session_ids:', missed.join(', '))

function* walkJsonl(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJsonl(full)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full
  }
}

let scanned = 0
let insertedMissing = 0
let refreshedExisting = 0
let scanMissed = 0
for (const jsonlPath of walkJsonl(codexSessionsDir)) {
  scanned++
  let identity
  try {
    identity = scanFileIdentitySync(jsonlPath).identity
  } catch {
    scanMissed++
    continue
  }
  if (!identity?.fleet_id || !VALID_ANY_FLEET_ID.test(identity.fleet_id)) continue
  const sessionId = path.basename(jsonlPath, '.jsonl')
  const existed = !!store.sessions[sessionId]
  const changed = upsertSessionIdentity(store, {
    session_id: sessionId,
    harness_kind: 'codex',
    fleet_id: identity.fleet_id,
    friendly_name: identity.friendly_name || undefined,
    cwd: identity.cwd || undefined,
    jsonl_path: jsonlPath,
    classified: true,
  })
  if (changed) {
    if (existed) refreshedExisting++
    else insertedMissing++
  }
}

console.log(`codex rollouts scanned: ${scanned}  inserted missing: ${insertedMissing}  refreshed existing: ${refreshedExisting}  scan errors: ${scanMissed}`)
console.log('by_fleet_id has releast (c16d9c53):', !!store.by_fleet_id['fleet:c16d9c53'])

if (dryRun) {
  console.log('\n[dry-run] not writing. Store would gain the above fleet_ids + by_fleet_id entries.')
} else {
  saveSessionIdentityStore(storePath, store)
  console.log(`\nWROTE ${storePath} (${recovered} fleet_ids recovered).`)
}
