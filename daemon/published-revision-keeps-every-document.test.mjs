/**
 * **A published revision contains every document in the tree.**
 *
 * This is a behaviour test: it builds a real checkout, settles it the way the
 * daemon does, and reads what actually landed in the published revision. It
 * does not reach into how the projection is computed, so the projection can be
 * rewritten without touching this file.
 *
 * **The behaviour it pins down.** `filteredProjectCommit` builds the revision
 * from a set of document roots. That set used to come from the project's STORED
 * `documentRoots`, written once when somebody linked the project and appended
 * to by the chat click-adopt path — and never recomputed. So a document added to
 * the branch afterwards was not in the list, and the revision published without
 * it while the file sat in the tree. Measured on a three-root project: one edit,
 * and two of the three documents returned 404 from `/source` while still on
 * disk.
 *
 * Skip specified the replacement on 2026-08-26 — *"document roots is just a
 * computed property of the git branch"*, *"create the directed include graph.
 * roots are roots"*, *"xr = link"* — and this asserts the consequence rather
 * than the mechanism: **add a paper to the branch and it is published, with
 * nobody declaring anything.**
 *
 * The two other properties here are the ones a naive "just publish everything"
 * would break, which is why they are asserted alongside: an `\input`-ed chapter
 * is part of its document rather than a document, and a paper that only
 * cross-references another with `xr` does not drag that other paper in.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGitProjectSync } from './git-project-sync.mjs'

function checkout(files) {
  const dir = mkdtempSync(join(tmpdir(), 'published-revision-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'test@tlda')
  git('config', 'user.name', 'test')
  write(dir, files)
  git('add', '-A')
  git('commit', '-qm', 'initial')
  // A real bare remote, because settle pushes a proposal ref and a test that
  // stopped short of the push would not be exercising the settle.
  const remote = mkdtempSync(join(tmpdir(), 'published-revision-remote-'))
  execFileSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' })
  git('remote', 'add', 'tlda', remote)
  return dir
}

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
}

/** The files in the revision the daemon published, read back out of git. */
function publishedFiles(dir, sync) {
  const ref = sync.refs.revisionRef
  return execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: dir, encoding: 'utf8' })
    .split('\n').filter(Boolean).sort()
}

async function settled(dir, { documentRoots = [] } = {}) {
  const sync = createGitProjectSync({
    sourceDir: dir,
    project: 'paper',
    daemonId: 'test-daemon',
    bindingId: 'test-binding',
    documentRoots,
    log: { info() {}, warn() {}, error() {} },
  })
  await sync.standOnWorkBranch()
  const result = await sync.editClusterSettled()
  return { sync, result }
}

test('a document added to the branch is published, with nothing declared', async () => {
  // The seed declares ONE root, the way a project linked with one document has
  // one. The second paper arrives later, the way a real one does.
  const dir = checkout({ 'first.tex': String.raw`\documentclass{article}\begin{document}one\end{document}` })
  try {
    write(dir, { 'second.tex': String.raw`\documentclass{article}\begin{document}two\end{document}` })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    const { sync, result } = await settled(dir, { documentRoots: ['first.tex'] })
    assert.ok(result?.ok !== false, `the settle succeeded (got ${JSON.stringify(result)})`)
    const files = publishedFiles(dir, sync)
    assert.ok(files.includes('second.tex'),
      `the paper added after linking is in the published revision (got ${files.join(', ')})`)
    assert.ok(files.includes('first.tex'), 'and so is the one that was declared')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an included chapter travels with its document, not as one', async () => {
  const dir = checkout({
    'main.tex': String.raw`\documentclass{book}\begin{document}\input{ch1}\end{document}`,
    'ch1.tex': String.raw`\chapter{One}`,
  })
  try {
    const { sync } = await settled(dir, { documentRoots: ['main.tex'] })
    const files = publishedFiles(dir, sync)
    assert.ok(files.includes('main.tex') && files.includes('ch1.tex'),
      `both are published (got ${files.join(', ')})`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('xr is a link: cross-referencing another paper does not swallow it', async () => {
  // If \externaldocument were an include edge, these two would form a cycle
  // with nothing pointing in from outside and the graph would find NO roots --
  // publishing nothing at all rather than too much.
  const dir = checkout({
    'a.tex': String.raw`\documentclass{article}\usepackage{xr}\externaldocument{b}\begin{document}x\end{document}`,
    'b.tex': String.raw`\documentclass{article}\begin{document}y\end{document}`,
  })
  try {
    const { sync, result } = await settled(dir, { documentRoots: [] })
    assert.ok(result?.ok !== false, `the settle succeeded (got ${JSON.stringify(result)})`)
    const files = publishedFiles(dir, sync)
    assert.ok(files.includes('a.tex') && files.includes('b.tex'),
      `both papers are published as documents (got ${files.join(', ')})`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
