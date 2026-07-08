// Behavioral guard for the app-worktree fence fix: projectDaemonOverridePath must
// resolve a git worktree's daemon override from the MAIN checkout's `.tlda-daemon.yaml`.
//
// Why it matters: `.tlda-daemon.yaml` is gitignored, so a linked worktree (an app
// agent in /private/tmp/*-wt) never receives a copy — the plain walk-up finds
// nothing and the agent falls to the base `wd` cage, unable to do app work. The fix
// walks up first (a worktree with its own override still wins), then falls back to
// `git rev-parse --git-common-dir` → the main checkout → its `.tlda-daemon.yaml`.
//
// Assertions compare the returned file's CONTENT (not its path) so macOS
// /private-vs-/var tmp symlink normalization can't make a correct result look wrong.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { projectDaemonOverridePath } from '../bin/lib/spawn/permission-ledger.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeMainCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-daemon-override-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'TLDA Test'])
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
  // The override is gitignored in the real repo — mirror that so it is NOT carried
  // into a linked worktree (which is the whole reason the fix is needed).
  writeFileSync(join(dir, '.gitignore'), '.tlda-daemon.yaml\n')
  git(dir, ['add', '.gitignore'])
  git(dir, ['commit', '-m', 'ignore override'])
  writeFileSync(join(dir, '.tlda-daemon.yaml'), 'default: main-checkout-override\n')
  return dir
}

test('worktree with no own override resolves the MAIN checkout\'s .tlda-daemon.yaml', () => {
  const main = makeMainCheckout()
  const wt = join(main, '.worktrees', 'app')
  try {
    git(main, ['worktree', 'add', '-b', 'app', wt])
    const result = projectDaemonOverridePath(wt)
    assert.ok(result, 'must resolve an override for the worktree')
    assert.equal(readFileSync(result, 'utf8'), 'default: main-checkout-override\n')
  } finally {
    rmSync(main, { recursive: true, force: true })
  }
})

test('a subdir inside the worktree also resolves the main checkout\'s override', () => {
  const main = makeMainCheckout()
  const wt = join(main, '.worktrees', 'app')
  try {
    git(main, ['worktree', 'add', '-b', 'app', wt])
    const sub = join(wt, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    const result = projectDaemonOverridePath(sub)
    assert.ok(result)
    assert.equal(readFileSync(result, 'utf8'), 'default: main-checkout-override\n')
  } finally {
    rmSync(main, { recursive: true, force: true })
  }
})

test('walk-up wins: a worktree carrying its OWN override is not overridden by main', () => {
  const main = makeMainCheckout()
  const wt = join(main, '.worktrees', 'app')
  try {
    git(main, ['worktree', 'add', '-b', 'app', wt])
    writeFileSync(join(wt, '.tlda-daemon.yaml'), 'default: worktree-own-override\n')
    const result = projectDaemonOverridePath(wt)
    assert.ok(result)
    assert.equal(readFileSync(result, 'utf8'), 'default: worktree-own-override\n')
  } finally {
    rmSync(main, { recursive: true, force: true })
  }
})

test('main checkout resolves its own override via walk-up (unchanged behavior)', () => {
  const main = makeMainCheckout()
  try {
    const result = projectDaemonOverridePath(main)
    assert.ok(result)
    assert.equal(readFileSync(result, 'utf8'), 'default: main-checkout-override\n')
  } finally {
    rmSync(main, { recursive: true, force: true })
  }
})

test('a non-git cwd returns null (base profile, unchanged)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-daemon-nogit-'))
  try {
    assert.equal(projectDaemonOverridePath(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a git checkout with NO override anywhere returns null', () => {
  const main = mkdtempSync(join(tmpdir(), 'tlda-daemon-noyaml-'))
  try {
    git(main, ['init', '-b', 'main'])
    git(main, ['config', 'user.email', 'test@example.com'])
    git(main, ['config', 'user.name', 'TLDA Test'])
    writeFileSync(join(main, 'README.md'), 'hi\n')
    git(main, ['add', 'README.md'])
    git(main, ['commit', '-m', 'init'])
    const wt = join(main, '.worktrees', 'app')
    git(main, ['worktree', 'add', '-b', 'app', wt])
    assert.equal(projectDaemonOverridePath(wt), null)
  } finally {
    rmSync(main, { recursive: true, force: true })
  }
})
