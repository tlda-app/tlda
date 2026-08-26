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

  return { root, working, head }
}

function appSync(working) {
  return createGitProjectSync({
    sourceDir: working,
    project: 'paper',
    daemonId: 'test-daemon',
    bindingId: 'test-binding',
    log: { info() {}, warn() {}, error() {} },
  })
}

test('a document the editor never opened survives a browser edit', async () => {
  const { root, working, head } = twoTrees()
  try {
    const sync = appSync(working)
    await sync.headChanged(head)
    // The editor's tree is a NORMAL CHECKOUT ON THE PROJECT BRANCH, which is
    // the whole design. Skip, 2026-08-26: "the browser editor is another
    // daemon. like any other" / "NORMAL FUCKING PROJECT BRANCH".
    const stood = await sync.standOnWorkBranch()
    assert.ok(stood?.ok, `it stands on its project branch (got ${JSON.stringify(stood)})`)

    // Only now does the editor write its buffer, which is the real order: the
    // room stands on the branch, then hydrates the file it is editing.
    writeFileSync(join(working, 'paper.tex'), String.raw`\documentclass{article}\begin{document}EDITED\end{document}`)

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
  // The other half. The editor writes the live buffer into this directory, so
  // standing the tree on its branch must not overwrite the edit being typed.
  const { root, working, head } = twoTrees()
  try {
    const sync = appSync(working)
    await sync.headChanged(head)
    await sync.standOnWorkBranch()
    writeFileSync(join(working, 'paper.tex'), String.raw`\documentclass{article}\begin{document}EDITED\end{document}`)
    const paper = execFileSync('cat', [join(working, 'paper.tex')], { encoding: 'utf8' })
    assert.match(paper, /EDITED/, 'the unsaved edit is still there')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a tree whose file is untracked still stands on the branch — the migration case', async () => {
  // My advocate: the test above moved the write AFTER standing, so the fixture
  // never contains a partial tree and its own setup performs the fix. This is
  // the state that actually exists: every room tree created before this change
  // is a scratch repo whose edited file was never committed to the branch, so
  // the file is UNTRACKED and `git checkout <branch>` refuses with "the
  // following untracked working tree files would be overwritten".
  //
  // Measured on the live box before shipping: 13 of 15 existing room trees are
  // in exactly this state. So the migration case is the one most likely to
  // fail, which makes it the one most worth a test.
  const { root, working, head } = twoTrees()
  try {
    // The buffer on disk BEFORE anything stands — untracked, colliding with a
    // path the branch carries.
    writeFileSync(join(working, 'paper.tex'), String.raw`\documentclass{article}\begin{document}EDITED\end{document}`)
    const sync = appSync(working)
    await sync.headChanged(head)
    const stood = await sync.standOnWorkBranch()
    assert.equal(stood?.ok, false,
      'git refuses this outright — which is why the room preserves the colliding file before standing')
    assert.match(String(stood?.reason || ''), /untracked working tree files would be overwritten/,
      `and it refuses for exactly that reason (got ${stood?.reason})`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
