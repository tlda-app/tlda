/**
 * **Editing one document in the browser must not delete the others.**
 *
 * The source editor does not write into the person's checkout. It writes into an
 * app-owned working tree, `.source-room/working`, and that tree only ever
 * contained the files somebody had opened in the editor. `headChanged` moved
 * HEAD onto the project revision and deliberately left the directory alone — so
 * HEAD held every document while the directory held one.
 *
 * Settle then stages that directory with `git add -A`, which records every file
 * present in HEAD and absent on disk as a **DELETION**. So one browser edit
 * published a revision with the project's other documents removed.
 *
 * **Reproduced live before the fix**, on a throwaway two-document project:
 * edit `paper.tex` through the source room, and `notes.md` went from 54 bytes to
 * **HTTP 404 in nine seconds**, while the working tree on the box contained
 * `paper.tex` alone. That is the "browser leg drops documents" report, and it is
 * why the sync demo has been running two routes instead of three.
 *
 * This is a behaviour test: it builds the two trees the way the system does and
 * asks what a settle publishes. It never inspects how the tree is brought up to
 * date, so that can be rewritten without touching this file.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGitProjectSync } from './git-project-sync.mjs'

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

/**
 * The two trees this bug lives between: the project's real tree, published as a
 * revision, and the app-owned tree the source room edits in.
 */
function twoTrees() {
  const root = mkdtempSync(join(tmpdir(), 'browser-edit-'))
  const bare = join(root, 'origin.git')
  mkdirSync(bare)
  execFileSync('git', ['init', '-q', '--bare', bare])

  const full = join(root, 'full')
  mkdirSync(full)
  git(full, 'init', '-q')
  git(full, 'config', 'user.email', 'test@tlda')
  git(full, 'config', 'user.name', 'test')
  writeFileSync(join(full, 'paper.tex'), String.raw`\documentclass{article}\begin{document}one\end{document}`)
  writeFileSync(join(full, 'notes.md'), '# Notes\n')
  git(full, 'add', '-A')
  git(full, 'commit', '-qm', 'a project with two documents')
  git(full, 'remote', 'add', 'tlda', bare)
  git(full, 'push', '-q', 'tlda', 'HEAD:refs/tlda/source/paper')
  const head = git(full, 'rev-parse', 'HEAD').trim()

  // The app-owned tree, as the source room creates it: `git init`, no commits,
  // and only the file that was opened.
  const working = join(root, 'working')
  mkdirSync(working)
  git(working, 'init', '-q', '-b', 'main')
  git(working, 'config', 'user.email', 'test@tlda')
  git(working, 'config', 'user.name', 'test')
  git(working, 'remote', 'add', 'tlda', bare)
  writeFileSync(join(working, 'paper.tex'), String.raw`\documentclass{article}\begin{document}EDITED\end{document}`)

  return { root, working, head }
}

function appSync(working) {
  return createGitProjectSync({
    sourceDir: working,
    project: 'paper',
    daemonId: 'test-daemon',
    bindingId: 'test-binding',
    appOwnedWorkingTree: true,
    log: { info() {}, warn() {}, error() {} },
  })
}

test('a document the editor never opened survives a browser edit', async () => {
  const { root, working, head } = twoTrees()
  try {
    const sync = appSync(working)
    await sync.headChanged(head)

    // Settle the way an editor save does, then read what was actually
    // published. Asserting on `git status` first would measure an intermediate
    // index state that the settle itself resolves -- the question is what
    // landed in the revision, not what the index looked like on the way.
    const result = await sync.editClusterSettled()
    assert.ok(result?.ok !== false, `the settle succeeded (got ${JSON.stringify(result)})`)

    const published = git(working, 'ls-tree', '-r', '--name-only', sync.refs.revisionRef)
      .split('\n').filter(Boolean).sort()
    assert.ok(published.includes('notes.md'),
      `the document nobody opened is still in the published revision (got ${published.join(', ')})`)
    assert.ok(published.includes('paper.tex'), 'and so is the edited one')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the edit in progress is not clobbered by bringing the tree up to date', async () => {
  // The other half, and the reason this restores only ABSENT files. The editor
  // writes the live buffer into this directory; a checkout of the whole tree
  // would overwrite it and throw away the edit being typed.
  const { root, working, head } = twoTrees()
  try {
    const sync = appSync(working)
    await sync.headChanged(head)
    const paper = execFileSync('cat', [join(working, 'paper.tex')], { encoding: 'utf8' })
    assert.match(paper, /EDITED/, 'the unsaved edit is still there')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
