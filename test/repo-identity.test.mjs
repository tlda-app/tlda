import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isWorktreeCheckoutPath, resolveRepoIdentity } from '../shared/repo-identity.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-repo-identity-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'TLDA Test'])
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
  return dir
}

test('isWorktreeCheckoutPath detects TLDA worktree checkout paths', () => {
  assert.equal(isWorktreeCheckoutPath('/Users/skip/work/tlda/.worktrees/branch'), true)
  assert.equal(isWorktreeCheckoutPath('/Users/skip/.claude/worktrees/branch'), true)
  assert.equal(isWorktreeCheckoutPath('/Users/skip/work/tlda'), false)
  assert.equal(isWorktreeCheckoutPath(''), false)
})

test('resolveRepoIdentity reports clean branch checkout identity', () => {
  const repo = makeRepo()
  try {
    const nested = join(repo, 'nested')
    mkdirSync(nested)
    const sha = git(repo, ['rev-parse', 'HEAD'])
    const identity = resolveRepoIdentity(nested)

    assert.equal(identity.checkoutPath, realpathSync(repo))
    assert.equal(identity.gitSha, sha)
    assert.equal(identity.ref, 'main')
    assert.equal(identity.branch, 'main')
    assert.equal(identity.dirty, false)
    assert.equal(identity.isWorktree, false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('resolveRepoIdentity reports dirty tracked and untracked files', () => {
  const repo = makeRepo()
  try {
    writeFileSync(join(repo, 'README.md'), 'changed\n')
    assert.equal(resolveRepoIdentity(repo).dirty, true)

    git(repo, ['checkout', '--', 'README.md'])
    writeFileSync(join(repo, 'untracked.txt'), 'new\n')
    assert.equal(resolveRepoIdentity(repo).dirty, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('resolveRepoIdentity reports a non-null detached ref off main\'s tip', () => {
  // A detached HEAD whose commit is NOT main's tip keeps a detached ref — but branch
  // must be a non-null string now (readBuildInfo requires a non-empty branch).
  const repo = makeRepo()
  try {
    const first = git(repo, ['rev-parse', 'HEAD'])
    writeFileSync(join(repo, 'README.md'), 'second\n')
    git(repo, ['commit', '-am', 'second'])
    git(repo, ['checkout', '--detach', first])
    const identity = resolveRepoIdentity(repo)

    assert.equal(identity.gitSha, first)
    assert.equal(identity.ref, `detached:${first.slice(0, 12)}`)
    assert.equal(identity.branch, `detached:${first.slice(0, 12)}`)
    assert.notEqual(identity.branch, null)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('resolveRepoIdentity reports main when a worktree checkout IS at main\'s tip', () => {
  // The live-deploy case: a build runs from a transient staging worktree whose commit is
  // main's tip. build-info should name main, not the throwaway staging branch.
  const repo = makeRepo()
  const worktree = join(repo, '.worktrees', 'staging')
  try {
    const mainTip = git(repo, ['rev-parse', 'main'])
    git(repo, ['worktree', 'add', '-b', 'staging', worktree])
    const identity = resolveRepoIdentity(worktree)

    assert.equal(identity.checkoutPath, realpathSync(worktree))
    assert.equal(identity.gitSha, mainTip)
    assert.equal(identity.branch, 'main')
    assert.equal(identity.ref, 'main')
    assert.equal(identity.isWorktree, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('resolveRepoIdentity keeps a worktree branch name when off main\'s tip', () => {
  // A worktree branch that has advanced past main's tip keeps its own branch name.
  const repo = makeRepo()
  const worktree = join(repo, '.worktrees', 'side')
  try {
    git(repo, ['worktree', 'add', '-b', 'side', worktree])
    writeFileSync(join(worktree, 'README.md'), 'side change\n')
    git(worktree, ['commit', '-am', 'side commit'])
    const identity = resolveRepoIdentity(worktree)

    assert.equal(identity.checkoutPath, realpathSync(worktree))
    assert.equal(identity.ref, 'side')
    assert.equal(identity.branch, 'side')
    assert.equal(identity.dirty, false)
    assert.equal(identity.isWorktree, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
