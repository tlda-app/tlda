#!/usr/bin/env node
/**
 * Reattribute machine text stored in Skip's history as things he said.
 *
 * The terminal mirror writes an agent's typed `user` turns into fleet chat as
 * `fleet:skip`. Until 7/31 it could not always tell his typing from the lines
 * tlda and the harness put in the same terminal, so wake notices, login prompts,
 * notification lines, command output and interruption notices are stored under
 * his name. His words for it: "that isn't me", "a fucking system message".
 *
 * This moves those rows to `fleet:tlda` — one identity, because the question
 * every reader asks is binary: is this Skip or not. Which kind of machine text a
 * row was is not lost: the matching shape is recorded on the row.
 *
 * Nothing ambiguous is touched. A row is rewritten only when the shape table
 * below names it AND `isMachineAuthoredText` — the classifier the live ingest
 * path uses — independently agrees. A row the two disagree about is counted and
 * reported, never written.
 *
 * Reversible two ways: every (id, from_id) pair is written to a journal file
 * before anything is updated, and each rewritten row carries
 * `metadata.reattributed_from`.
 *
 * Usage:
 *   node bin/reattribute-terminal-system-messages.mjs [--db PATH] [--journal PATH]
 *                                                     [--sqlite MODULE] [--apply]
 *
 * Without --apply it reports and writes nothing. `--sqlite` names the
 * better-sqlite3 module when running outside a tree that resolves it, which is
 * the case on the server container.
 */

import { writeFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { createRequire } from 'module'

import { isMachineAuthoredText } from '../agent-runtime/terminal-chat-authorship.mjs'
import { isFullyMarked, LEADING_CONTROL } from '../shared/terminal-system-markers.mjs'

const HUMAN_ID = 'fleet:skip'
const SYSTEM_ID = 'fleet:tlda'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const require = createRequire(import.meta.url)
const Database = require(arg('--sqlite', 'better-sqlite3'))
const APPLY = process.argv.includes('--apply')
const DB_PATH = arg('--db', path.join(homedir(), '.config', 'tlda', 'fleet.db'))
const JOURNAL = arg('--journal', path.join(homedir(), '.config', 'tlda',
  'reattribute-terminal-system-messages.journal.json'))

// The shapes actually present in the data, each named so the rewritten row says
// which one matched. Order matters only for naming; membership is a disjunction.
const SHAPES = [
  ['return-notice', t => /^You were away as \S+ for /.test(t)],
  ['harness-interrupt', t => t.startsWith('[Request interrupted by user')],
  ['login-prompt', t => /^Call (?:login|register)\([^)]*\) with the (?:tlda|fleet) MCP server\b/.test(t)],
  ['notification', t => t.startsWith('📬')],
  ['marked-system-message', t => isFullyMarked(t)],
  ['command-stdout', t => t.startsWith('<local-command-stdout>')],
  ['command-caveat', t => t.startsWith('<local-command-caveat>')],
  ['bash-stdout', t => t.startsWith('<bash-stdout>')],
  ['bash-stderr', t => t.startsWith('<bash-stderr>')],
  ['channel-injection', t => t.startsWith('<channel')],
  ['task-notification', t => t.startsWith('<task-notification')],
  ['system-reminder', t => t.startsWith('<system-reminder')],
]

// Every shape is anchored at the start, so the prompt-clear (Ctrl-U) or a
// carriage return still on the front of an injected line hides it. Only
// whitespace and C0 controls come off; nothing printable is skipped, so a line of
// his cannot be dragged into a shape by this.
function shapeOf(text) {
  const start = String(text).replace(LEADING_CONTROL, '')
  for (const [name, test] of SHAPES) if (test(start)) return name
  return null
}

const db = new Database(DB_PATH, { readonly: !APPLY })
// The server holds this database open. Wait for its writes rather than failing
// the repair on a moment's contention; the update is one transaction, so a
// genuine timeout leaves the history exactly as it was.
db.pragma('busy_timeout = 15000')

const candidates = db.prepare(`
  SELECT id, timestamp, from_id, text, metadata
  FROM events
  WHERE type = 'chat'
    AND from_id = ?
    AND json_extract(metadata, '$.source') = 'terminal'
`).all(HUMAN_ID)

const matched = []
const disputed = []
const byShape = new Map()

for (const row of candidates) {
  const text = row.text || ''
  const shape = shapeOf(text)
  const classifier = isMachineAuthoredText(text)
  if (!shape && !classifier) continue          // his words — untouched
  if (!shape || !classifier) { disputed.push({ row, shape, classifier }); continue }
  matched.push({ row, shape })
  byShape.set(shape, (byShape.get(shape) || 0) + 1)
}

console.log(`database        ${DB_PATH}`)
console.log(`terminal rows as ${HUMAN_ID}: ${candidates.length}`)
console.log(`machine-shaped:  ${matched.length}`)
console.log(`his words:       ${candidates.length - matched.length - disputed.length} (untouched)`)
for (const [shape, n] of [...byShape].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(6)}  ${shape}`)
}

if (disputed.length) {
  console.log(`\nAMBIGUOUS — shape table and classifier disagree, left alone: ${disputed.length}`)
  for (const d of disputed.slice(0, 10)) {
    console.log(`  id=${d.row.id} shape=${d.shape} classifier=${d.classifier} ${JSON.stringify((d.row.text || '').slice(0, 90))}`)
  }
}

if (!APPLY) {
  console.log(`\nDry run. Nothing written. Re-run with --apply to rewrite ${matched.length} rows.`)
  process.exit(0)
}

writeFileSync(JOURNAL, JSON.stringify({
  db: DB_PATH,
  at: new Date().toISOString(),
  from: HUMAN_ID,
  to: SYSTEM_ID,
  rows: matched.map(({ row, shape }) => ({ id: row.id, from_id: row.from_id, shape })),
}, null, 1))
console.log(`\njournal written: ${JOURNAL} (${matched.length} rows)`)

const update = db.prepare(`
  UPDATE events
  SET from_id = ?,
      metadata = json_set(
        json_set(COALESCE(metadata, '{}'), '$.reattributed_from', ?),
        '$.reattributed_shape', ?)
  WHERE id = ? AND from_id = ?
`)
const run = db.transaction(rows => {
  let n = 0
  for (const { row, shape } of rows) n += update.run(SYSTEM_ID, row.from_id, shape, row.id, row.from_id).changes
  return n
})
const changed = run(matched)
console.log(`rewrote ${changed} rows to ${SYSTEM_ID}`)
if (changed !== matched.length) {
  console.error(`WARNING: expected ${matched.length}, changed ${changed} — rows moved under us`)
  process.exit(1)
}
