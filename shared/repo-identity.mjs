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

  const ref = branch || `detached:${gitSha.slice(0, 12)}`
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], checkoutPath)
  const commonDir = absPath(checkoutPath, git(['rev-parse', '--git-common-dir'], checkoutPath))
  const mainGitDir = resolve(checkoutPath, '.git')
  const isWorktree = commonDir !== mainGitDir || isWorktreeCheckoutPath(checkoutPath)

  return {
    checkoutPath,
    gitSha,
    ref,
    branch,
    dirty: status.length > 0,
    isWorktree,
  }
}
