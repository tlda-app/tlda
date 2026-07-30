import { execFile } from 'child_process'
import { stat, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export const DEFAULT_WORKTREE_NODE_MODULES_BUDGET_BYTES = 50 * 1024 ** 3

async function registeredWorktrees(repoRoot) {
  const { stdout } = await execFileP(
    'git',
    ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
    { timeout: 10_000, encoding: 'utf8' },
  )
  return stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => resolve(line.slice('worktree '.length)))
}

async function processWorkingDirectories() {
  const { stdout } = await execFileP(
    'lsof',
    ['-a', '-d', 'cwd', '-Fn'],
    { timeout: 10_000, encoding: 'utf8' },
  )
  return new Set(
    stdout
      .split('\n')
      .filter(line => line.startsWith('n/'))
      .map(line => resolve(line.slice(1))),
  )
}

function containsPath(parent, child) {
  return child === parent || child.startsWith(`${parent}/`)
}

async function nodeModulesEntries(worktrees) {
  const entries = []
  for (const worktree of worktrees) {
    const path = join(worktree, 'node_modules')
    try {
      const metadata = await stat(path)
      entries.push({ worktree, path, mtimeMs: metadata.mtimeMs })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (!entries.length) return entries

  const { stdout } = await execFileP(
    'du',
    ['-sk', ...entries.map(entry => entry.path)],
    { timeout: 10 * 60_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
  const sizes = new Map()
  for (const line of stdout.trim().split('\n')) {
    const match = line.match(/^(\d+)\s+(.+)$/)
    if (match) sizes.set(resolve(match[2]), Number(match[1]) * 1024)
  }
  return entries.map(entry => ({ ...entry, sizeBytes: sizes.get(entry.path) || 0 }))
}

export async function reapWorktreeNodeModules({
  repoRoot,
  budgetBytes = DEFAULT_WORKTREE_NODE_MODULES_BUDGET_BYTES,
  worktrees,
  activeCwds,
  remove = path => rm(path, { recursive: true, force: true }),
} = {}) {
  if (!repoRoot) throw new Error('repoRoot is required')
  const roots = worktrees || await registeredWorktrees(repoRoot)
  const main = resolve(repoRoot)
  const candidates = await nodeModulesEntries(roots.filter(root => resolve(root) !== main))
  const cwdSet = activeCwds || await processWorkingDirectories()
  const totalBytes = candidates.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  let retainedBytes = totalBytes
  const evicted = []
  const pinned = []

  for (const entry of candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (retainedBytes <= budgetBytes) break
    if ([...cwdSet].some(cwd => containsPath(entry.worktree, cwd))) {
      pinned.push(entry)
      continue
    }
    await remove(entry.path)
    retainedBytes -= entry.sizeBytes
    evicted.push(entry)
  }

  return {
    budgetBytes,
    totalBytes,
    retainedBytes,
    evicted,
    pinned,
    overBudgetBytes: Math.max(0, retainedBytes - budgetBytes),
  }
}
