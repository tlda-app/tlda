import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

function defaultGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function startDir(p) {
  const abs = resolve(p || process.cwd())
  if (!existsSync(abs)) return dirname(abs)
  return statSync(abs).isDirectory() ? abs : dirname(abs)
}

function absPath(base, p) {
  return isAbsolute(p) ? resolve(p) : resolve(base, p)
}

export function isWorktreeCheckoutPath(p) {
  return !!p && (/\/\.worktrees\//.test(p) || /\/\.claude\/worktrees\//.test(p))
}

export function resolveRepoIdentity(path = process.cwd(), { git = defaultGit } = {}) {
  const cwd = startDir(path)
  const checkoutPath = absPath(cwd, git(['rev-parse', '--show-toplevel'], cwd))
  const gitSha = git(['rev-parse', 'HEAD'], checkoutPath)

  let branch = null
  try {
    branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], checkoutPath)
  } catch {
    branch = null
  }

  const checkoutBranch = branch

  // Report the canonical branch (main) when the deployed commit IS main's tip. A live deploy
  // is built from a transient staging worktree (a throwaway branch or a detached HEAD), but
  // "everything runs from main", so build-info should name main rather than the worktree's
  // branch. Also guarantees a non-null branch string — readBuildInfo requires a non-empty one.
  if (branch !== 'main') {
    try {
      if (git(['rev-parse', 'main'], checkoutPath) === gitSha) branch = 'main'
    } catch {
      // no main ref (e.g. a bare/empty runtime checkout) — leave branch as resolved
    }
  }

  const ref = branch || `detached:${gitSha.slice(0, 12)}`
  if (!branch) branch = ref
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], checkoutPath)
  const commonDir = absPath(checkoutPath, git(['rev-parse', '--git-common-dir'], checkoutPath))
  const mainGitDir = resolve(checkoutPath, '.git')
  const isWorktree = commonDir !== mainGitDir || isWorktreeCheckoutPath(checkoutPath)
  const mainCheckoutPath = commonDir.endsWith('/.git') ? dirname(commonDir) : checkoutPath

  return {
    checkoutPath,
    mainCheckoutPath,
    gitSha,
    ref,
    branch,
    checkoutBranch,
    dirty: status.length > 0,
    isWorktree,
  }
}
