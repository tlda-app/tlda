#!/usr/bin/env node
// One ingester. The daemon tails Claude session JSONLs and pushes each activity
// into the store; that is the ingester, and there is no second one.
//
// On 2026-08-17 there was a second. `server/lib/edit-events.mjs` sat downstream
// of the first, read the activities it had already stored, and wrote a derived
// copy into its own JSONL -- persisting `fleet_activity_event_id`, the primary
// key of the row it was duplicating, beside the duplicate. A UI pill then read
// the whole of that file back every 1000ms per open source file, which is what
// the server's lag profiler caught at 809ms stalls. Skip: "we don't need a
// second fucking ingester ... they're in the fucking db ... i mean query or
// subscribe, like chat."
//
// The shape is cheap to detect and the signal is unusually clean: a module that
// BOTH reads canonical store data AND writes files is either the upload path or
// it is re-deriving something the store already holds. There is currently one
// such module and it is an upload. So this asserts the set, rather than a count
// or a heuristic -- adding to it means editing this list, which is the point at
// which somebody has to say why.
//
// This is not a lint rule and it does not try to be clever. It is a list.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Writes file content. Metadata calls (existsSync/statSync/mkdirSync) do not count.
const WRITES_FILES = /\bwriteFileSync\(|\bappendFileSync\(|\bcreateWriteStream\(/
// Stores a pointer to a row that is already in the database.
//
// The first version of this check looked for "reads the store AND writes files"
// in one module, and it did NOT catch edit-events.mjs -- verified by restoring
// the deleted file and watching this pass. The store read lived in
// unified-server.mjs and the write lived in edit-events.mjs, so the shape spans
// two modules and no single-file rule sees it.
//
// What DOES identify it, in the file doing the writing, is the foreign key. The
// duplicate carried `fleet_activity_event_id: activity.id` -- it recorded where
// the real row lives and wrote the copy anyway. A file persisting the id of a
// store row is, by construction, persisting something the store already has.
const STORES_A_ROW_ID = /\b\w*(?:event|activity|message)_id\s*:\s*(?:\w+\.)*\b(?:id|_id)\b/

// Modules allowed to do both, each with the reason it is not an ingester.
const ALLOWED = new Map([
  // (empty: nothing currently writes a store row id to a file)
])

const dirs = ['server/lib', 'server/routes']
const offenders = []
for (const dir of dirs) {
  for (const entry of readdirSync(join(root, dir))) {
    if (!entry.endsWith('.mjs') || entry.includes('.test.')) continue
    const rel = `${dir}/${entry}`
    const source = readFileSync(join(root, rel), 'utf8')
    if (WRITES_FILES.test(source) && STORES_A_ROW_ID.test(source) && !ALLOWED.has(rel)) offenders.push(rel)
  }
}

const stale = [...ALLOWED.keys()].filter(rel => {
  try {
    const source = readFileSync(join(root, rel), 'utf8')
    return !(WRITES_FILES.test(source) && STORES_A_ROW_ID.test(source))
  } catch {
    return true
  }
})

let failures = 0
if (offenders.length) {
  failures++
  console.error('FAIL a second ingester appeared:')
  for (const rel of offenders) {
    console.error(`  ${rel} writes a file carrying the id of a database row.`)
  }
  console.error('  If it re-derives what the store already holds, delete it and query instead.')
  console.error('  If it genuinely does not, add it to ALLOWED in this file with the reason.')
}
// A stale allowlist is the way this check rots into nothing: entries outlive
// the code they excused, and the next real offender gets waved through by a
// line nobody re-read.
if (stale.length) {
  failures++
  console.error(`FAIL stale ALLOWED entries (no longer match the shape, remove them): ${stale.join(', ')}`)
}

console.log(failures === 0
  ? `PASS one ingester (${ALLOWED.size} allowed, all still accurate)`
  : `FAIL one ingester (${failures})`)
process.exit(failures === 0 ? 0 : 1)
