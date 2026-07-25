#!/usr/bin/env node
// Nothing synchronous belongs on the server's event loop.
//
// Skip: "nothing fucking synchronous should be on the fucking event loop."
//
// Not a style rule. On 2026-07-25 the server froze for 1.2-2.0s at a time and
// Skip could not get a sentence transcribed. Cause: `execFileSync('git', ...)`
// in the task-doc materializer -- one subprocess per task, ~47ms of dead event
// loop each. A second copy sat in the artifact materializer. The server is
// single-threaded: while a sync call runs, every browser, every agent, and
// Skip's voice relay get nothing.
//
// SCOPE, and why it is narrow.
//
// Only SUBPROCESS calls, only in `server/` and `daemon/`. Three deliberate
// exclusions:
//   - `mcp-server/` is a separate stdio process per agent. Blocking there costs
//     that one agent, not the fleet.
//   - `bin/`, `cli/`, `agent-launch/` are one-shot; there is no loop to starve.
//   - Synchronous *fs* calls are excluded. There are ~400 of them and most are
//     sub-millisecond; failing on all of them would get this guard deleted
//     rather than obeyed. Subprocesses are what actually cost seconds.
//
// HOW IT FAILS. Per-file budgets below record the sync subprocess calls that
// existed when this landed. Adding one anywhere -- including inside a file that
// already has debt -- pushes that file over budget and fails. Removing them and
// lowering the number is the intended direction.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ROOTS = ['server', 'daemon']
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'server/public'])
const PROHIBITED = ['execSync(', 'execFileSync(', 'spawnSync(']

// Known debt as of 2026-07-25, with what each one actually is. These are NOT
// blessed -- they are the backlog, made countable. Lower a number when you fix
// one; the guard will tell you if you raise one.
const BUDGET = {
  // pandoc markdown<->latex conversion on request paths, plus `git show` and
  // `git log --max-count=500`. Real multi-hundred-ms blocks; unfixed.
  'server/routes/projects.mjs': 5,
  // `pkill` in browser/bridge cleanup routes, and a deepgram bridge restart.
  // Dev-facing, but still on the loop.
  'server/unified-server.mjs': 10,
  // pandoc in the build path. The build itself is already a child process
  // (build-runner.mjs:1753); this is the conversion around it.
  'server/lib/build-runner.mjs': 1,
  // The source-authority three-way merge. Making it async ripples into the
  // source-push path -- flagged 2026-07-25 for someone with a clear head.
  'server/lib/source-lifecycle.mjs': 1,
  // Skip, 2026-07-25, on outline: "maybe it would be cool if it were used at
  // some point, but for now, I don't know." Undecided, not on a hot path.
  // Excluded rather than forced into a decision nobody asked for.
  'server/lib/outline/outline.mjs': 1,
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(ROOT, full)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(rel) && !SKIP_DIRS.has(entry.name)) yield* walk(full)
    } else if (/\.(mjs|js|ts|tsx)$/.test(entry.name)) {
      yield full
    }
  }
}

const counts = new Map()
const sites = new Map()
for (const root of CHECK_ROOTS) {
  const dir = path.join(ROOT, root)
  if (!fs.existsSync(dir)) continue
  for (const file of walk(dir)) {
    const rel = path.relative(ROOT, file)
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      for (const needle of PROHIBITED) {
        if (!line.includes(needle)) continue
        counts.set(rel, (counts.get(rel) || 0) + 1)
        if (!sites.has(rel)) sites.set(rel, [])
        sites.get(rel).push(`${rel}:${index + 1}: ${needle}`)
      }
    })
  }
}

const over = []
for (const [file, count] of counts) {
  const budget = BUDGET[file] || 0
  if (count > budget) over.push({ file, count, budget })
}

if (over.length) {
  console.error('Synchronous subprocess calls on the server event loop.')
  console.error('The server is single-threaded: while these run, nobody gets anything --')
  console.error("including Skip's voice. Use the async form and await it.")
  console.error('')
  for (const { file, count, budget } of over) {
    console.error(`  ${file}: ${count} found, budget ${budget}`)
    for (const site of sites.get(file)) console.error(`      ${site}`)
  }
  console.error('')
  console.error('If a call genuinely cannot be async yet, raise its budget in')
  console.error(`${path.relative(ROOT, fileURLToPath(import.meta.url))} WITH a reason saying what it is.`)
  console.error('"It was already there" is how the ones we found got there.')
  process.exit(1)
}

// Budgets that are now too generous: report, do not fail. Shrinking is good news.
const stale = Object.entries(BUDGET).filter(([file, budget]) => (counts.get(file) || 0) < budget)
if (stale.length) {
  console.log('sync-on-event-loop guard: budgets that can be lowered')
  for (const [file, budget] of stale) console.log(`  ${file}: ${counts.get(file) || 0} found, budget ${budget}`)
}
