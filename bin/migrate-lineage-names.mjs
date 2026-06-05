#!/usr/bin/env node
/**
 * One-time migration to the phase-in-name convention.
 *
 * Before: phase lived in an `agents.phase` column, and multi-member lineages
 * had collision-suffixed names like "conc5", "conc5-1b", "conc5-2".
 * After:  phase is encoded in the friendly name — dawn = bare base, day =
 * "<base>:day", dusk = "<base>:dusk".
 *
 * Only multi-member lineages need fixing: a solo agent's bare name already IS
 * its (dawn) name, so it's correct as-is once the column stops being read.
 *
 * Usage: node bin/migrate-lineage-names.mjs [path-to-fleet.db] [--apply]
 *   Without --apply it's a dry run (prints the plan, changes nothing).
 */
import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import { nameForPhase } from '../shared/lineage-name.mjs'

const dbPath = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(os.homedir(), '.config', 'tlda', 'fleet.db')
const apply = process.argv.includes('--apply')

const db = new Database(dbPath)

// Multi-member lineages: >1 live, named member.
const multi = db.prepare(`
  SELECT lineage_id, COUNT(*) AS n FROM agents
  WHERE lineage_id IS NOT NULL AND dead = 0 AND friendly_name IS NOT NULL
  GROUP BY lineage_id HAVING n > 1
`).all()

console.log(`DB: ${dbPath}`)
console.log(`Multi-member lineages: ${multi.length}${apply ? ' (APPLY)' : ' (dry run)'}`)

const renameTmp = db.prepare('UPDATE agents SET friendly_name = ? WHERE id = ?')
const migrated = []
const skipped = []

for (const { lineage_id } of multi) {
  const base = db.prepare('SELECT friendly_name FROM lineages WHERE id = ?').get(lineage_id)?.friendly_name
  if (!base) { console.log(`  ! lineage ${lineage_id} has no base name, skipping`); continue }
  const members = db.prepare(
    'SELECT id, friendly_name, phase, last_seen FROM agents WHERE lineage_id = ? AND dead = 0 AND friendly_name IS NOT NULL'
  ).all(lineage_id)

  // Auto-resolve: at most one holder per phase slot. Candidates for a slot are
  // the lineage members whose old phase maps to it, PLUS any live agent outside
  // the lineage that already holds the target name (e.g. a stray "wavelet-infconv"
  // with no lineage). Most-recently-seen wins the slot and takes the name (joining
  // the lineage if it was outside); every other candidate loses its name (set
  // NULL) and stays in the lineage as nameless history.
  const seenMs = (m) => (m.last_seen ? new Date(m.last_seen).getTime() : 0)
  const byPhase = { dawn: [], day: [], dusk: [] }
  for (const m of members) {
    const phase = (m.phase === 'day' || m.phase === 'dusk') ? m.phase : 'dawn'
    byPhase[phase].push(m)
  }
  const ops = [] // { id, to, join } — final name + whether to set lineage_id
  for (const phase of ['dawn', 'day', 'dusk']) {
    const target = nameForPhase(base, phase)
    const candidates = [...byPhase[phase]]
    const outside = db.prepare(
      'SELECT id, last_seen FROM agents WHERE friendly_name = ? AND dead = 0 AND (lineage_id IS NULL OR lineage_id != ?)'
    ).all(target, lineage_id)
    for (const o of outside) candidates.push({ id: o.id, friendly_name: target, last_seen: o.last_seen, _outside: true })
    if (candidates.length === 0) continue
    candidates.sort((a, b) => seenMs(b) - seenMs(a))
    const winner = candidates[0]
    ops.push({ id: winner.id, from: winner.friendly_name, to: target, phase, join: !!winner._outside, win: true })
    for (const loser of candidates.slice(1)) {
      ops.push({ id: loser.id, from: loser.friendly_name, to: null, phase, join: false, win: false })
    }
  }

  console.log(`  lineage "${base}":`)
  for (const o of ops) console.log(`    ${o.from}  →  ${o.to === null ? '(nameless history)' : o.to}  (${o.phase}${o.win ? '' : ', dropped'}${o.join ? ', joined from outside' : ''})`)

  if (apply) {
    // Two-pass to dodge the live-name UNIQUE index: temp names first, then final.
    db.transaction(() => {
      for (const o of ops) renameTmp.run(`__mig_${o.id}`, o.id)
      for (const o of ops) {
        if (o.join) db.prepare('UPDATE agents SET friendly_name = ?, lineage_id = ? WHERE id = ?').run(o.to, lineage_id, o.id)
        else renameTmp.run(o.to, o.id)
      }
    })()
    migrated.push(base)
  }
}

console.log('')
console.log(`Clean lineages ${apply ? 'migrated' : 'ready'}: ${apply ? migrated.length : multi.length - skipped.length}`)
if (skipped.length) console.log(`Needs manual resolution: ${skipped.map(s => s.base).join(', ')}`)
console.log(apply ? 'Done.' : 'Dry run complete — re-run with --apply to write.')
db.close()
