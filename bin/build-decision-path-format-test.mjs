#!/usr/bin/env node
// A project whose relevant-files.json predates the relative-path format holds
// ABSOLUTE paths. Exact-match against project-relative changedFiles never hits,
// so shouldBuildOnPush returns `outside-tree` for every push forever — and the
// file is only rewritten by a successful build, so it cannot recover.
//
// balancing-act was wedged this way 2026-07-21 → 2026-08-11: its
// relevant-files.json mtime and lastBuild were the same minute. The Aug 4 build
// of balancing-act-jose, same directory, same daemon, is the counterfactual —
// its file was relative-path and it built normally.
//
// Case 1 is the regression: it FAILS on the pre-fix tree.

import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'build-decision-'))

const { shouldBuildOnPush } = await import('../server/lib/build-decision.mjs')
const { outputDir, initProjectStore } = await import('../server/lib/project-store.mjs')
await initProjectStore(root)

function withScope(name, files) {
  const dir = outputDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'relevant-files.json'), JSON.stringify({ files }))
}

const project = { format: 'svg', pages: 61, buildStatus: 'success' }
const push = { changedFiles: ['main.tex'], anyChanged: true }
let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} — build=${actual}, expected ${expected}`)
}

// 1. Legacy absolute-path scope. The wedge. Must build.
withScope('legacy-absolute', [
  '/Users/skip/work/balancing-act/main.tex',
  '/Users/skip/work/balancing-act/figure/geometry-handpicked-crossing.bb',
])
check('absolute-path scope still builds on main.tex',
  shouldBuildOnPush(project, 'legacy-absolute', push).build, true)

// 2. Current relative-path scope. Must keep working.
withScope('current-relative', ['main.tex', 'figure/geometry-handpicked-crossing.bb'])
check('relative-path scope builds on main.tex',
  shouldBuildOnPush(project, 'current-relative', push).build, true)

// 3. A genuinely irrelevant file must still NOT build, in both formats —
//    otherwise the fix has just disabled the filter.
withScope('irrelevant-rel', ['main.tex'])
check('unrelated file does not build (relative)',
  shouldBuildOnPush(project, 'irrelevant-rel', { changedFiles: ['scratch/notes.tex'], anyChanged: true }).build, false)

withScope('irrelevant-abs', ['/Users/skip/work/balancing-act/main.tex'])
check('unrelated file does not build (absolute)',
  shouldBuildOnPush(project, 'irrelevant-abs', { changedFiles: ['scratch/notes.tex'], anyChanged: true }).build, false)

// 4. A suffix must not match a DIFFERENT file that merely ends the same way.
withScope('suffix-trap', ['/Users/skip/work/other-paper/appendix/main.tex'])
check('bare basename does not match a deeper unrelated path',
  shouldBuildOnPush(project, 'suffix-trap', { changedFiles: ['sections/main.tex'], anyChanged: true }).build, false)

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nbuild decision path format: ok' : `\nbuild decision path format: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
