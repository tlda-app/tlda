#!/usr/bin/env node

/**
 * One-time repair: put back the task titles that a re-delegation overwrote.
 *
 * A hand-off used to write its own note over the task's title -- fixed in
 * mcp-server/fleet-tools.mjs, so this repairs the rows already damaged and is
 * not needed again. The mapping was recovered from each task's delegate events
 * and reviewed before this script existed.
 *
 * THE MAPPING FILE IS THE INPUT. Nothing is recomputed at run time: the
 * reviewed artifact is what runs. Rows are read out of the markdown table in
 * scratch/title-restore-mapping.md, and the eight no-op rows that were excluded
 * on review are refused by id.
 *
 * PASS --db EXPLICITLY. The default below is a guess and was wrong: it was
 * copied from bin/migrate-to-lineages.mjs and resolves to nothing on the
 * machines that would run this, because the store is embedded in the server
 * process and lives on whichever host serves the environment.
 *
 * A FIXTURE CANNOT CATCH A WRONG DEFAULT -- IT IS HANDED THE RIGHT PATH EVERY
 * TIME. Every test of this script passed while the default was broken, because
 * each one supplied --db. That is the same shape as the defect this script
 * repairs: an instrument that answers confidently, having been asked a
 * different question than the one that mattered. The guards below exist
 * because of it.
 *
 * Usage:
 *   node scratch/restore-task-titles.mjs --db /path.db            # dry run, writes nothing
 *   node scratch/restore-task-titles.mjs --db /path.db --write    # perform the repair
 *
 * Idempotent: a row already reading its target is skipped, not rewritten, so a
 * second run reports 79 skipped and changes nothing.
 *
 * Touches `tasks.description` and inserts one `task_update` event per changed
 * row. Nothing else: no owner change, no status change, no message appended, no
 * recipients row -- so nothing is notified and nobody's inbox moves.
 */

import Database from 'better-sqlite3'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'os'

const args = process.argv.slice(2)
const write = args.includes('--write')
const dbIdx = args.indexOf('--db')
const DB_PATH = dbIdx >= 0 ? args[dbIdx + 1] : path.join(os.homedir(), '.config', 'tlda', 'fleet.db')
const mapIdx = args.indexOf('--mapping')
const MAP_PATH = mapIdx >= 0 ? args[mapIdx + 1] : 'scratch/title-restore-mapping.md'

// Excluded on review: `restore to` is byte-identical to what the row already
// reads. These had their description derived AT CREATION, which is correct
// behaviour and not the defect. Writing them would change nothing; refusing
// them by id keeps the approved set and the executed set the same 79.
const EXCLUDED = new Set([
  'fleet:7608-mswu27lb', 'fleet:85f8-mswu9ude', 'fleet:85f8-mswotfwy',
  'fleet:85f8-mswhot8v', 'fleet:521b-mswa1fa5', 'fleet:a3f4-mswadp6j',
  'fleet:9c98-mswppfi4', 'fleet:a3f6-msuyp7xc',
])
const APPROVED_COUNT = 79

// | `task-id` | restore to | event | chain |
const ROW = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|$/

const parsed = []
for (const line of readFileSync(MAP_PATH, 'utf8').split('\n')) {
  const m = line.match(ROW)
  if (m) parsed.push({ id: m[1], title: m[2], eventId: Number(m[3]), chain: Number(m[4]) })
}

// The table is the contract. The count that matters is the APPROVED set after
// exclusions, checked below -- not the file's own row count, because the file
// reviewed at 87 rows and a regeneration under the corrected detection rule
// emits the same 79 with the eight no-ops already absent. Both parse to the
// same 79 targets with byte-identical titles; a file missing a row does not.
for (const r of parsed) {
  if (r.title.includes('\\|') || r.title.includes('⏎')) {
    console.error(`mapping parse: row ${r.id} still carries a table escape. Refusing to run.`)
    process.exit(1)
  }
}
const targets = parsed.filter(r => !EXCLUDED.has(r.id))
if (targets.length !== APPROVED_COUNT) {
  console.error(`expected ${APPROVED_COUNT} approved rows after exclusions, got ${targets.length}. Refusing to run.`)
  process.exit(1)
}

console.log(`${write ? 'WRITING' : '[DRY RUN] no writes'} — ${DB_PATH}`)
console.log(`mapping: ${MAP_PATH} (${parsed.length} rows, ${EXCLUDED.size} excluded, ${targets.length} to apply)\n`)

// better-sqlite3 CREATES a database when the path does not exist, so a wrong
// --db does not fail -- it makes an empty store and then dies on the first
// prepare, having left a stray 0-byte file behind. Refuse first, and say which
// path was tried: a repair script must never be the thing that invents a store.
if (!existsSync(DB_PATH)) {
  console.error(`no database at ${DB_PATH}. Refusing to run — pass the real store with --db.`)
  process.exit(1)
}
const db = new Database(DB_PATH, { readonly: !write, fileMustExist: true })
db.pragma('busy_timeout = 10000')
const hasTasks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()
if (!hasTasks) {
  console.error(`${DB_PATH} has no tasks table — this is not the fleet store. Refusing to run.`)
  process.exit(1)
}

const getTask = db.prepare('SELECT id, description, agent, status FROM tasks WHERE id = ?')
const setDescription = db.prepare('UPDATE tasks SET description = ? WHERE id = ?')
const insertEvent = db.prepare(`
  INSERT INTO events (type, timestamp, from_id, text, metadata, task_id, agent_id)
  VALUES ('task_update', ?, ?, ?, ?, ?, ?)
`)

const FROM = 'fleet:8d2f3d14'
const changed = []
const skipped = []
const missing = []

const apply = db.transaction(rows => {
  for (const row of rows) {
    const task = getTask.get(row.id)
    if (!task) { missing.push(row); continue }
    const before = task.description || ''
    if (before === row.title) { skipped.push({ ...row, before }); continue }
    changed.push({ ...row, before })
    if (!write) continue
    setDescription.run(row.title, row.id)
    insertEvent.run(
      new Date().toISOString(),
      FROM,
      `title restored: ${row.title}`,
      JSON.stringify({
        title_restore: true,
        previous_description: before,
        restored_description: row.title,
        source_event_id: row.eventId,
        chain: row.chain,
        reason: 'a re-delegation overwrote this title; repaired from the task\'s own delegate events',
      }),
      row.id,
      task.agent || null,
    )
  }
})

apply(targets)

for (const c of changed) console.log(`  ${c.id}\n    was: ${c.before}\n    now: ${c.title}   (event ${c.eventId}, chain ${c.chain})`)
if (skipped.length) {
  console.log(`\nalready correct, skipped:`)
  for (const s of skipped) console.log(`  ${s.id}`)
}
if (missing.length) {
  console.log(`\nNOT FOUND in tasks (reported, not written):`)
  for (const m of missing) console.log(`  ${m.id}`)
}

console.log(`\napproved ${targets.length} · ${write ? 'changed' : 'would change'} ${changed.length} · already correct ${skipped.length} · missing ${missing.length}`)
if (!write) console.log('\nNothing was written. Re-run with --write to apply.')
db.close()
