#!/usr/bin/env node
// One-off: reclaim the replica command payloads already sitting in lifecycle
// journals on disk.
//
// `d0c2aac49` stops new ones accumulating — a replica drops its command when it
// settles, and a replica pending past the expiry goes terminal and drops it.
// But both run on WRITE, so a project that has not accepted a revision since
// keeps carrying its payloads, and `GET /api/projects` reads every journal in
// full on every request.
//
// Measured on the live volume 2026-08-18, before this ran:
//
//   130,251,627  bytes across 179 journals
//   108,491,928  of it in replica.command
//    95,653,998  in bregman alone, one pending replica holding 54,374,893
//
// Applies exactly the rules the running code applies, so it cannot drift from
// them: settled replicas lose `command`; replicas pending past the expiry
// become `expired` and lose it. Nothing else is touched.
//
// Dry by default. Pass --apply to write. Every file is backed up beside itself
// before it is rewritten.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { globSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')
const ROOT = process.argv.find(a => a.startsWith('--root='))?.slice(7)
  || '/app/server/persist/projects'
const EXPIRY_MS = Number(process.env.TLDA_PENDING_REPLICA_EXPIRY_HOURS || 6) * 60 * 60 * 1000

const journals = globSync(`${ROOT}/*/.source-lifecycle/operations.json`)
const now = Date.now()
const nowIso = new Date(now).toISOString()
const cutoff = now - EXPIRY_MS

let before = 0
let after = 0
let settledDropped = 0
let expired = 0
let pendingKept = 0
let filesChanged = 0

for (const path of journals) {
  const raw = readFileSync(path, 'utf8')
  before += raw.length
  let journal
  try {
    journal = JSON.parse(raw)
  } catch (e) {
    console.error(`  SKIP unparseable: ${path} (${e.message})`)
    after += raw.length
    continue
  }

  let changed = false
  for (const lifecycle of Object.values(journal.revisionLifecycle || {})) {
    const replicas = lifecycle?.replicas
    if (!replicas) continue
    for (const [bindingId, replica] of Object.entries(replicas)) {
      if (!replica || !('command' in replica)) continue
      const { command, ...carried } = replica
      if (replica.state !== 'pending') {
        replicas[bindingId] = carried
        settledDropped++
        changed = true
        continue
      }
      const seen = Date.parse(replica.updatedAt || '') || 0
      if (seen !== 0 && seen <= cutoff) {
        replicas[bindingId] = {
          ...carried,
          state: 'expired',
          result: { ok: false, error: `replica pending longer than ${EXPIRY_MS}ms; payload dropped, re-materialise from the source revision` },
          updatedAt: nowIso,
        }
        expired++
        changed = true
      } else {
        pendingKept++
      }
    }
  }

  const next = JSON.stringify(journal)
  after += changed ? next.length : raw.length
  if (!changed) continue
  filesChanged++
  if (!APPLY) continue

  const backup = `${path}.pre-prune`
  if (!existsSync(backup)) copyFileSync(path, backup)
  writeFileSync(path, next)
}

const fmt = n => n.toLocaleString('en-US')
console.log(APPLY ? 'APPLIED' : 'DRY RUN (pass --apply to write)')
console.log(`  journals            ${fmt(journals.length)}`)
console.log(`  files changed       ${fmt(filesChanged)}`)
console.log(`  settled payloads    ${fmt(settledDropped)} dropped`)
console.log(`  pending expired     ${fmt(expired)}`)
console.log(`  pending kept        ${fmt(pendingKept)} (inside the expiry, a live retry needs these)`)
console.log(`  bytes before        ${fmt(before)}`)
console.log(`  bytes after         ${fmt(after)}`)
console.log(`  reclaimed           ${fmt(before - after)}`)
