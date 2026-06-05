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

  // Conservative: only migrate a lineage we can resolve UNAMBIGUOUSLY. Flag the
  // rest for human resolution rather than guess (guessing could orphan a live
  // agent's work or steal a name from an unrelated agent).
  const byPhase = { dawn: [], day: [], dusk: [] }
  for (const m of members) {
    const phase = (m.phase === 'day' || m.phase === 'dusk') ? m.phase : 'dawn'
    byPhase[phase].push(m)
  }
  const conflicts = []
  // (a) duplicate holders of a phase slot
  for (const phase of ['dawn', 'day', 'dusk']) {
    if (byPhase[phase].length > 1) {
      conflicts.push(`${byPhase[phase].length} members at "${phase}": ${byPhase[phase].map(m => m.friendly_name).join(', ')}`)
    }
  }
  // (b) a target name already held by a LIVE agent outside this lineage
  const targets = ['dawn', 'day', 'dusk']
    .filter(p => byPhase[p].length === 1)
    .map(p => nameForPhase(base, p))
  for (const t of targets) {
    const holder = db.prepare(
      'SELECT id FROM agents WHERE friendly_name = ? AND dead = 0 AND (lineage_id IS NULL OR lineage_id != ?)'
    ).get(t, lineage_id)
    if (holder) conflicts.push(`target "${t}" already held by outside agent ${holder.id}`)
  }

  if (conflicts.length) {
    console.log(`  lineage "${base}": ⚠ NEEDS MANUAL RESOLUTION`)
    for (const c of conflicts) console.log(`      - ${c}`)
    skipped.push({ base, conflicts })
    continue
  }

  const plan = members.map(m => {
    const phase = (m.phase === 'day' || m.phase === 'dusk') ? m.phase : 'dawn'
    return { id: m.id, from: m.friendly_name, to: nameForPhase(base, phase), phase }
  })
  console.log(`  lineage "${base}":`)
  for (const p of plan) console.log(`    ${p.from}  →  ${p.to}  (${p.phase})`)

  if (apply) {
    // Two-pass to dodge the live-name UNIQUE index: temp names first, then final.
    db.transaction(() => {
      for (const p of plan) renameTmp.run(`__mig_${p.id}`, p.id)
      for (const p of plan) renameTmp.run(p.to, p.id)
    })()
    migrated.push(base)
  }
}

console.log('')
console.log(`Clean lineages ${apply ? 'migrated' : 'ready'}: ${apply ? migrated.length : multi.length - skipped.length}`)
if (skipped.length) console.log(`Needs manual resolution: ${skipped.map(s => s.base).join(', ')}`)
console.log(apply ? 'Done.' : 'Dry run complete — re-run with --apply to write.')
db.close()
