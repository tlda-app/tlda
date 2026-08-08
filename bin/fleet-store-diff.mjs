#!/usr/bin/env node
/**
 * Diff two fleet stores by CONTENT and report what only the older one holds.
 *
 * Written 2026-08-08 after the 2026-08-02 vacuum swap discarded ~15 minutes of
 * committed writes on the live Fly store — 118 events including ten of Skip's
 * own dictated messages, one live agent row, two tasks — while every check
 * anyone ran said the data was intact.
 *
 * WHY THE OBVIOUS CHECKS CANNOT SEE IT
 *
 * A `VACUUM INTO` copy carries its own `sqlite_sequence`. After the swap the
 * server resumes inserting from the COPY's counter, so it re-issues the same
 * event ids to different events. Therefore:
 *
 *   - every id in the old file exists in the new one          (guaranteed)
 *   - count(*) over the shared id range matches exactly       (guaranteed)
 *   - a sampled id-existence check passes                     (guaranteed)
 *
 * None of those is evidence of preservation; each is a consequence of the
 * failure. The lost rows are not absent, they are impersonated. The only check
 * that finds them is content equality on (timestamp, type, from_id, text).
 *
 * RUN IT BEFORE THE SWAP, NOT AFTER
 *
 * The point is to run while both files exist and the old one can still be put
 * back. Run after the fact it can only name what you already lost, which is how
 * it came to be written.
 *
 * Usage:
 *   node fleet-store-diff.mjs --old <path> --new <path> [--out lost.json]
 *                             [--sqlite MODULE]
 *
 * `--sqlite` names the better-sqlite3 module when running outside a tree that
 * resolves it; on the Fly container that is /app/node_modules/better-sqlite3.
 *
 * Exit status: 0  the new file contains everything the old one did
 *              1  the old file holds rows the new one does not — do not delete it
 *              2  usage error, open failure, or an inconclusive scan
 *
 * Cost: one scan of the old file's tail plus indexed lookups in the new one. It
 * deliberately does NOT run integrity_check or count(*) over the live file —
 * those read every page and starve the disk the server is reading from.
 */

import { writeFileSync } from 'fs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const OLD = arg('--old')
const NEW = arg('--new')
const OUT = arg('--out')
if (!OLD || !NEW) {
  console.error('usage: fleet-store-diff.mjs --old <path> --new <path> [--out lost.json] [--sqlite MODULE]')
  process.exit(2)
}

let Database
try {
  Database = require(arg('--sqlite', 'better-sqlite3'))
} catch (e) {
  console.error(`cannot load better-sqlite3: ${e.message}`)
  console.error('pass --sqlite /app/node_modules/better-sqlite3 on the server container')
  process.exit(2)
}

let oldDb, newDb
try {
  oldDb = new Database(OLD, { readonly: true, fileMustExist: true })
  newDb = new Database(NEW, { readonly: true, fileMustExist: true })
} catch (e) {
  console.error(`open failed: ${e.message}`)
  process.exit(2)
}

const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

for (const t of ['events', 'agents', 'tasks']) {
  for (const [label, db] of [['old', oldDb], ['new', newDb]]) {
    if (!hasTable(db, t)) {
      console.error(`${label} file has no '${t}' table — this is not a fleet store: ${label === 'old' ? OLD : NEW}`)
      process.exit(2)
    }
  }
}

const lost = { old: OLD, new: NEW, events: [], agents: [], tasks: [], side_tables: {} }

// ---- events: content equality, walking down from the top of the old id space.
//
// Only the tail can diverge — everything below the copy point is shared — so
// find the boundary rather than comparing every row. Walk back from max(id)
// until AGREE_RUN consecutive ids match on content. A run rather than a single
// match, because two adjacent events can coincide by chance.
const AGREE_RUN = 200
const CHUNK = 5000

const maxOld = oldDb.prepare('SELECT max(id) m FROM events').get().m
const getNew = newDb.prepare('SELECT id, timestamp, type, from_id, text FROM events WHERE id = ?')
const getOldRange = oldDb.prepare(
  'SELECT id, timestamp, type, from_id, text FROM events WHERE id <= ? AND id > ? ORDER BY id DESC'
)

const sameEvent = (a, b) =>
  b && a.timestamp === b.timestamp && a.type === b.type &&
  a.from_id === b.from_id && (a.text || '') === (b.text || '')

let cursor = maxOld
let agreed = 0
let boundary = null

scan: while (cursor > 0 && agreed < AGREE_RUN) {
  const rows = getOldRange.all(cursor, cursor - CHUNK)
  if (!rows.length) break
  for (const row of rows) {
    if (sameEvent(row, getNew.get(row.id))) {
      if (++agreed >= AGREE_RUN) { boundary = row.id; break scan }
    } else {
      agreed = 0
      lost.events.push(row)
    }
  }
  cursor -= CHUNK
}

lost.events.reverse()
// `boundary` is where the agreeing run *completed*, which is AGREE_RUN ids below
// the actual divergence. Report the real one — the lowest id whose content
// differs — so the number means what it says.
const firstDivergentId = lost.events.length ? lost.events[0].id : null
lost.divergence = {
  first_divergent_id: firstDivergentId,
  agreement_confirmed_from_id: boundary,
  max_old_id: maxOld,
  scanned_to: cursor,
  converged: boundary !== null,
}

// A scan that never found its agreeing run compared nothing meaningful — the two
// files may not be versions of the same store, or the divergence runs deeper
// than the scan reached. Refuse to report a row count that would read as an
// answer; an inconclusive result is not a clean result.
if (!lost.divergence.converged) {
  console.error(`INCONCLUSIVE: no run of ${AGREE_RUN} agreeing events found down to id ${cursor}.`)
  console.error('These may not be two versions of the same store. Not reporting a loss count.')
  process.exit(2)
}

// ---- agents and tasks: keyed by id, and those ids are not reused, so presence
// is an honest check here in a way it is not for events.
const hasAgent = newDb.prepare('SELECT 1 FROM agents WHERE id = ?')
for (const a of oldDb.prepare('SELECT * FROM agents').all()) {
  if (!hasAgent.get(a.id)) lost.agents.push(a)
}
const hasTask = newDb.prepare('SELECT 1 FROM tasks WHERE id = ?')
for (const t of oldDb.prepare('SELECT * FROM tasks').all()) {
  if (!hasTask.get(t.id)) lost.tasks.push(t)
}

// ---- side tables whose rows belong to a lost event.
//
// Deliberately not a sweep of every table. Tables that rotate — transport_
// operations, daemon_outbox_processed — always show old rows the new file
// lacks, because they were pruned on purpose, and reporting those as losses
// buries the real ones.
//
// The event-referencing tables are DISCOVERED from the schema, not listed. A
// hardcoded list silently under-reports the moment a table is added: the first
// version of this script named `recipients` and missed `unread.event_id`, which
// had lost 24 rows in the test fixture.
const SIDE_TABLES = []
for (const { name } of oldDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
  if (name.startsWith('sqlite_') || name.includes('_fts')) continue
  for (const fk of oldDb.prepare(`PRAGMA foreign_key_list(${name})`).all()) {
    if (fk.table !== 'events') continue
    const pk = oldDb.prepare(`PRAGMA table_info(${name})`).all().filter(c => c.pk > 0).map(c => c.name)
    SIDE_TABLES.push({ table: name, key: pk.length ? pk : [fk.from], scopeCol: fk.from })
  }
}
// Keyed by agent rather than by event, so they are named rather than discovered.
SIDE_TABLES.push(
  { table: 'session_entries', key: ['id'], scopeCol: null },
  { table: 'agent_daemon_routes', key: ['agent_id'], scopeCol: null },
)

for (const { table, key, scopeCol } of SIDE_TABLES) {
  if (!hasTable(oldDb, table) || !hasTable(newDb, table)) continue
  const newCols = newDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  const oldCols = oldDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  const usable = key.every(k => newCols.includes(k) && oldCols.includes(k))
  if (!usable) {
    console.error(`skipping ${table}: key ${key.join('+')} is not present in both files`)
    continue
  }
  const has = newDb.prepare(`SELECT 1 FROM ${table} WHERE ${key.map(k => `${k} = ?`).join(' AND ')}`)
  const rows = scopeCol
    ? oldDb.prepare(`SELECT * FROM ${table} WHERE ${scopeCol} >= ?`).all(boundary)
    : oldDb.prepare(`SELECT * FROM ${table}`).all()
  const missing = rows.filter(r => !has.get(...key.map(k => r[k])))
  if (missing.length) lost.side_tables[table] = missing
}

// ---- report
const total = lost.events.length + lost.agents.length + lost.tasks.length
const byAuthor = {}
for (const e of lost.events) byAuthor[e.from_id] = (byAuthor[e.from_id] || 0) + 1

console.log(`old: ${OLD}`)
console.log(`new: ${NEW}`)
console.log(`first divergent id: ${firstDivergentId ?? '(none)'}  (content agrees from ${boundary} down; max old id ${maxOld})`)
console.log('')
console.log(`events only in old : ${lost.events.length}`)
console.log(`agents only in old : ${lost.agents.length}`)
console.log(`tasks  only in old : ${lost.tasks.length}`)
for (const [t, rows] of Object.entries(lost.side_tables)) {
  console.log(`${t.padEnd(19)}: ${rows.length}`)
}

if (lost.events.length) {
  console.log('\nlost events by author:')
  for (const [who, count] of Object.entries(byAuthor).sort((a, b) => b[1] - a[1])) {
    const flag = who === 'fleet:skip' ? '   <-- Skip. He dictates; this is the only record of it.' : ''
    console.log(`  ${String(count).padStart(5)}  ${who}${flag}`)
  }
  console.log(`\nlost window: ${lost.events[0].timestamp} -> ${lost.events[lost.events.length - 1].timestamp}`)
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify(lost, null, 1))
  console.log(`\nwrote ${OUT}`)
}

if (total === 0) {
  console.log('\nThe new file contains everything the old one did.')
  process.exit(0)
}
console.log(`\nThe old file holds ${total} rows the new one does not. Do not delete it.`)
process.exit(1)
