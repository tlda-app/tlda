#!/usr/bin/env node
/**
 * Build a known-answer fixture reproducing the 2026-08-02 vacuum-swap loss, so
 * `fleet-store-diff.mjs` can be tested against an answer decided in advance
 * rather than against its own output.
 *
 * The failure being reproduced, exactly:
 *
 *   1. a copy of the store seals at some event id (the boundary);
 *   2. the original keeps taking writes past it;
 *   3. the copy is swapped in, so those writes are gone;
 *   4. the copy resumes its OWN sqlite_sequence, re-issuing the SAME ids to
 *      different events.
 *
 * Step 4 is the whole reason this needed a tool. It makes the lost rows present
 * rather than absent, so id-existence checks and count(*) both pass on a store
 * that has lost data.
 *
 * Usage: node make-vacuum-loss-fixture.mjs --old <path> --new <path>
 *                                          [--lose N] [--sqlite MODULE]
 *
 * `--old` is read-only. `--new` is rewritten in place and must already be a
 * copy of `--old`. Prints the expected diff result as JSON.
 */

import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const arg = (n, d = null) => {
  const i = process.argv.indexOf(n)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}

const OLD = arg('--old')
const NEW = arg('--new')
const LOSE = Number(arg('--lose', '40'))
if (!OLD || !NEW) {
  console.error('usage: make-vacuum-loss-fixture.mjs --old <path> --new <path> [--lose N] [--sqlite MODULE]')
  process.exit(2)
}

const Database = require(arg('--sqlite', 'better-sqlite3'))
const oldDb = new Database(OLD, { readonly: true, fileMustExist: true })
const newDb = new Database(NEW, { fileMustExist: true })

// The rows the "original" held past the boundary — these are what the swap
// destroys, and what the diff must find.
const doomed = oldDb.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(LOSE).reverse()
const boundary = doomed[0].id

// An agent and a task that existed past the boundary. Pick ones the new file
// will lose entirely, the way `filter-pill-parity` was lost.
const doomedAgent = oldDb.prepare('SELECT * FROM agents ORDER BY registered_at DESC LIMIT 1').get()
const doomedTask = oldDb.prepare('SELECT * FROM tasks ORDER BY rowid DESC LIMIT 1').get()

// Rows in other tables that reference these events go with them — the real swap
// lost `recipients` rows alongside the events they belonged to. Discover the
// referencing tables from the schema rather than naming them, so a table added
// later is not silently skipped.
const referencingEvents = []
for (const { name } of newDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
  if (name.startsWith('sqlite_') || name.includes('_fts')) continue
  for (const fk of newDb.prepare(`PRAGMA foreign_key_list(${name})`).all()) {
    if (fk.table === 'events') referencingEvents.push({ table: name, column: fk.from })
  }
}

newDb.transaction(() => {
  // (2)+(3): the swap discards everything the original wrote past the boundary.
  for (const { table, column } of referencingEvents) {
    newDb.prepare(`DELETE FROM ${table} WHERE ${column} >= ?`).run(boundary)
  }
  newDb.prepare('DELETE FROM events WHERE id >= ?').run(boundary)
  if (doomedAgent) newDb.prepare('DELETE FROM agents WHERE id = ?').run(doomedAgent.id)
  if (doomedTask) newDb.prepare('DELETE FROM tasks WHERE id = ?').run(doomedTask.id)

  // (4): the copy re-issues the SAME ids to different events. This is what makes
  // the loss invisible to every id-based check.
  const ins = newDb.prepare(
    'INSERT INTO events (id, type, timestamp, from_id, text, metadata, task_id, agent_id) ' +
    'VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)'
  )
  for (let k = 0; k < doomed.length; k++) {
    ins.run(
      boundary + k,
      'activity',
      `2026-08-02T03:5${k % 10}:00.000Z`,   // earlier than the events they replace
      'fleet:recycled',
      `recycled id ${boundary + k}`
    )
  }
})()

const expected = {
  boundary_id: boundary,
  events: doomed.length,
  agents: doomedAgent ? 1 : 0,
  tasks: doomedTask ? 1 : 0,
  lost_agent_id: doomedAgent ? doomedAgent.id : null,
  lost_task_id: doomedTask ? doomedTask.id : null,
  window: { from: doomed[0].timestamp, to: doomed[doomed.length - 1].timestamp },
}

// The trap, asserted rather than described: after this, every id-based check
// still passes on a store that has lost `LOSE` events.
const idsPresent = oldDb.prepare('SELECT id FROM events ORDER BY id DESC LIMIT ?').all(LOSE)
  .every(r => newDb.prepare('SELECT 1 FROM events WHERE id = ?').get(r.id))
const countOld = oldDb.prepare('SELECT count(*) c FROM events').get().c
const countNew = newDb.prepare('SELECT count(*) c FROM events').get().c
expected.trap = {
  every_old_id_exists_in_new: idsPresent,
  event_counts_match: countOld === countNew,
  note: 'both true by construction — this is why id checks cannot detect the loss',
}

console.log(JSON.stringify(expected, null, 1))
