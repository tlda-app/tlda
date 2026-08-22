/**
 * User territory: the Git state in a person's own checkout that belongs to the
 * person and not to tlda.
 *
 * The rule, relayed rather than quoted: app/daemon never touches the person's
 * branch; an explicitly user-invoked relay owns merge-to-main and push. This
 * module makes that checkable as one thing rather than as a handful of ad-hoc
 * assertions, so every path that runs against a real checkout (the shadow
 * mirror, `project link`, settle) can be held to the same standard.
 *
 * What is IN user territory:
 *   - every branch ref under refs/heads/, and where HEAD points
 *   - the real index (`git ls-files -s`), including unmerged stages
 *   - the working tree, byte for byte, tracked and untracked alike
 *   - in-progress operation state: MERGE_HEAD, CHERRY_PICK_HEAD, REBASE_HEAD,
 *     REVERT_HEAD, and the rebase directories
 *   - the stash
 *
 * What is NOT, and is deliberately absent from the snapshot: refs the app
 * maintains for itself — refs/tlda/** and the shadow tags. Writing those is the
 * mirror doing its job, and a snapshot that flagged them would make the
 * assertion useless for exactly the path it exists to check.
 */

import { execFile as execFileCb } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFileCb)

const IN_PROGRESS_FILES = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REBASE_HEAD',
  'REVERT_HEAD',
  'MERGE_MSG',
  'BISECT_LOG',
]

const IN_PROGRESS_DIRS = ['rebase-merge', 'rebase-apply']

async function git(cwd, args) {
  const { stdout } = await execFileP('git', args, { cwd, timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function gitOrNull(cwd, args) {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

function walkWorktree(root) {
  const files = {}
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = rel ? path.join(root, rel) : root
    for (const dirent of fs.readdirSync(abs, { withFileTypes: true })) {
      // `.git` is the repository, not the working tree. Its contents are covered
      // by the ref, index and in-progress readings, which describe the parts a
      // person can observe rather than every byte of Git's own bookkeeping.
      if (!rel && dirent.name === '.git') continue
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
      const childAbs = path.join(root, childRel)
      if (dirent.isDirectory()) {
        stack.push(childRel)
      } else if (dirent.isSymbolicLink()) {
        files[childRel] = `symlink:${fs.readlinkSync(childAbs)}`
      } else if (dirent.isFile()) {
        const stat = fs.lstatSync(childAbs)
        const digest = crypto.createHash('sha256').update(fs.readFileSync(childAbs)).digest('hex')
        files[childRel] = `${(stat.mode & 0o111) ? '100755' : '100644'}:${digest}`
      }
    }
  }
  return files
}

/**
 * Read everything the person owns in `dir`. The result is plain data, so a
 * caller can take one before a path runs and one after, and hand both to
 * `diffUserTerritory`.
 */
export async function snapshotUserTerritory(dir) {
  const gitDirRaw = await git(dir, ['rev-parse', '--absolute-git-dir'])
  const gitDir = gitDirRaw.trim()

  const symbolicHead = (await gitOrNull(dir, ['symbolic-ref', '-q', 'HEAD']))?.trim() ?? null
  const head = (await gitOrNull(dir, ['rev-parse', 'HEAD']))?.trim() ?? null

  const branchesRaw = await git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'])
  const branches = {}
  for (const line of branchesRaw.split('\n')) {
    if (!line.trim()) continue
    const [refname, objectname] = line.trim().split(' ')
    branches[refname] = objectname
  }

  const inProgress = {}
  for (const name of IN_PROGRESS_FILES) {
    const full = path.join(gitDir, name)
    inProgress[name] = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').trim() : null
  }
  for (const name of IN_PROGRESS_DIRS) {
    inProgress[name] = fs.existsSync(path.join(gitDir, name)) ? 'present' : null
  }

  return {
    dir,
    symbolicHead,
    head,
    branches,
    // Byte-exact index listing. `-s` carries mode, blob and stage number, so an
    // unmerged entry shows up here as stage 1/2/3 rows rather than needing a
    // separate reading.
    index: await git(dir, ['ls-files', '-s']),
    unmerged: await git(dir, ['ls-files', '-u']),
    worktree: walkWorktree(dir),
    inProgress,
    stashRef: (await gitOrNull(dir, ['rev-parse', '-q', '--verify', 'refs/stash']))?.trim() ?? null,
    stashList: (await gitOrNull(dir, ['stash', 'list'])) ?? '',
  }
}

function diffMaps(before, after, label, violations) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue
    violations.push(`${label} ${key}: ${before[key] ?? '(absent)'} -> ${after[key] ?? '(absent)'}`)
  }
}

/**
 * Every way `after` departs from `before`, as one line each. Empty means the
 * person's territory is exactly as they left it.
 */
export function diffUserTerritory(before, after) {
  const violations = []
  if (before.symbolicHead !== after.symbolicHead) {
    violations.push(`HEAD moved to a different ref: ${before.symbolicHead} -> ${after.symbolicHead}`)
  }
  if (before.head !== after.head) {
    violations.push(`HEAD commit moved: ${before.head} -> ${after.head}`)
  }
  diffMaps(before.branches, after.branches, 'branch', violations)
  if (before.index !== after.index) {
    violations.push(`the real index changed:\n--- before\n${before.index}--- after\n${after.index}`)
  }
  if (before.unmerged !== after.unmerged) {
    violations.push(`unmerged index entries changed:\n--- before\n${before.unmerged}--- after\n${after.unmerged}`)
  }
  diffMaps(before.worktree, after.worktree, 'worktree file', violations)
  diffMaps(before.inProgress, after.inProgress, 'in-progress state', violations)
  if (before.stashRef !== after.stashRef) {
    violations.push(`stash ref changed: ${before.stashRef ?? '(none)'} -> ${after.stashRef ?? '(none)'}`)
  }
  if (before.stashList !== after.stashList) {
    violations.push(`stash list changed:\n--- before\n${before.stashList}--- after\n${after.stashList}`)
  }
  return violations
}

/**
 * Did history the app fetched from the server become ancestry of the branch the
 * person is standing on?
 *
 * This is a different question from "did the ref move", and a sharper one. A
 * branch can move for reasons that are the person's own; a branch that descends
 * from a commit only the server had can only have got there one way. `true` here
 * means server history is in the person's own history now, permanently, and
 * removing it is a rewrite of their branch rather than an undo.
 */
export async function fetchedHistoryIsAncestry(dir, fetchedRevision, commitish = 'HEAD') {
  try {
    await git(dir, ['merge-base', '--is-ancestor', fetchedRevision, commitish])
    return true
  } catch {
    return false
  }
}

export function assertUserTerritoryUnchanged(before, after, label) {
  const violations = diffUserTerritory(before, after)
  if (violations.length === 0) return
  const error = new Error(`${label}: the app wrote ${violations.length} thing(s) the user owns\n\n${violations.map(v => `  * ${v}`).join('\n')}`)
  error.violations = violations
  throw error
}
