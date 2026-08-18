#!/usr/bin/env node
// Things that were deliberately deleted, and a check that they have not come back.
//
// Every other check in this repo runs on what a change ADDS. Nothing asserts a
// thing is still gone, so a stale branch can reinstate a removed feature and the
// diff reads as ordinary work. That is half of what Skip asked for on
// 2026-08-17: "once specified — finished, tested, and NOT RUINED BY SUBSEQUENT
// WORK OR BAD MERGES."
//
// It is a LEDGER, not a framework. One file, one array, one grep. Adding an
// entry is a few lines; there is no config format and no plugin point, and if it
// ever grows one it will be big enough that somebody deletes it. If you are
// tempted to generalise this, don't — write the next entry instead.
//
// WHAT BELONGS HERE: something removed on a ruling, where its return is a
// regression rather than a new decision. WHAT DOES NOT: something removed by
// accident. A wrongly deleted feature needs restoring, not a guard keeping it
// out — those are the opposite case and putting one here would nail the mistake
// down.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = process.env.TLDA_DELETED_GUARD_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..')

const LEDGER = [
  {
    what: 'the reload-client route — a POST that reloaded a named human\'s browser',
    deletedIn: '3dcf02b9f',
    symbols: ['reload-client', 'reloadHumanFleetClients', 'targeted-client-control'],
    ruling: 'AGENTS.md §"An open user tab is not a deployment target". Skip, '
      + '2026-08-11 17:28:59 EDT: "An open tab should never fucking reload under '
      + 'me." The correct end state is that no surface can reload his tab.',
  },
  {
    what: 'the cross-lane gate — a working-directory-inferred check that refused '
      + 'an agent\'s call unless it typed a marker phrase',
    deletedIn: '1267710ee',
    symbols: ['crossLaneBlock', 'inferAgentLane', 'lanesMayCoordinate', 'looksLikeManagementMessage'],
    ruling: 'AGENTS.md §"We do not do auth between agents", which names this by '
      + 'symbol and says: "Do not reintroduce it under another name, and do not '
      + 'treat \'a small friction\' as a permitted amount of auth."',
  },
]

// Code only. A mention in a doc, a changelog, or this file\'s own test is a
// record of the deletion rather than the thing coming back.
const SEARCH_DIRS = [
  'server', 'src', 'daemon', 'bin', 'cli', 'mcp-server', 'shared',
  'agent-launch', 'agent-runtime', 'scripts', 'packages',
]
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', '.git', 'scratch', 'test-results'])
const CODE = /\.(mjs|cjs|js|ts|tsx)$/
// This file names every banned symbol, and so does its test. Both are the
// ledger, not a reintroduction.
const SELF = new Set(['bin/deleted-stays-deleted-guard.mjs', 'bin/deleted-stays-deleted-guard-test.mjs'])

function* codeFiles(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* codeFiles(full)
    else if (entry.isFile() && CODE.test(entry.name)) yield full
  }
}

const failures = []
for (const dir of SEARCH_DIRS) {
  const full = join(ROOT, dir)
  try { if (!statSync(full).isDirectory()) continue } catch { continue }
  for (const file of codeFiles(full)) {
    const rel = relative(ROOT, file)
    if (SELF.has(rel)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const entry of LEDGER) {
      for (const symbol of entry.symbols) {
        lines.forEach((line, i) => {
          if (line.includes(symbol)) failures.push({ entry, symbol, rel, line: i + 1, text: line.trim() })
        })
      }
    }
  }
}

if (failures.length === 0) {
  console.log(`deleted-stays-deleted: ${LEDGER.length} deletions still deleted`)
  process.exit(0)
}

console.error('deleted-stays-deleted: something that was deliberately removed is back.\n')
for (const entry of LEDGER) {
  const hits = failures.filter((f) => f.entry === entry)
  if (hits.length === 0) continue
  console.error(`  ${entry.what}`)
  console.error(`  deleted in ${entry.deletedIn}`)
  console.error(`  ${entry.ruling}\n`)
  for (const hit of hits) console.error(`    ${hit.rel}:${hit.line}  ${hit.symbol}   ${hit.text.slice(0, 100)}`)
  console.error('')
}
console.error('If this is a merge bringing back an old branch, the branch needs rebasing onto a')
console.error('main that carries the deleting commit. If the deletion is genuinely being reversed,')
console.error('that is Skip\'s call and the ledger entry comes out in the same commit.')
process.exit(1)
