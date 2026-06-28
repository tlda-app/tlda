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

test('resolveRepoIdentity reports detached ref without branch', () => {
  const repo = makeRepo()
  try {
    const sha = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['checkout', '--detach', 'HEAD'])
    const identity = resolveRepoIdentity(repo)

    assert.equal(identity.branch, null)
    assert.equal(identity.ref, `detached:${sha.slice(0, 12)}`)
    assert.equal(identity.gitSha, sha)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('resolveRepoIdentity detects a real git worktree checkout', () => {
  const repo = makeRepo()
  const worktree = join(repo, '.worktrees', 'side')
  try {
    git(repo, ['worktree', 'add', '-b', 'side', worktree])
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
