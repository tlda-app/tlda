/**
 * `tlda project merge` — land the version history tlda accumulated for a
 * project on a real branch.
 *
 * Specified in docs/source-authority-state-machine.md §"Getting the work back
 * out: the merge operation". Every rule this file implements traces to a
 * message in the 2026-08-22 14:30–14:53 EDT conversation, cited in that table.
 *
 * WHY IT IS A REPLAY AND NOT A MERGE. The shadow repository is built by cloning
 * the project repo and running `git-filter-repo --path` (server/lib/shadow-repo.mjs,
 * the `projectRepoPath` branch of `ensureShadowRepo`). Rewriting a commit
 * changes its sha, so the shadow shares NO commit identity with the project
 * repo — the builder says so itself where it removes the origin remote: "the
 * project repo is not upstream of the shadow". Nothing in it can merge back by
 * git identity. It can only be re-applied as content: `format-patch` on the
 * shadow side, `git am` on the target. Author, date and message survive, so the
 * target gains one commit per real change rather than one commit standing for
 * all of them.
 *
 * ONE MODULE, TWO CALL SITES — the CLI (cli/tlda.mjs `cmdProjectMerge`) and
 * the server. Not two implementations. A second copy is how the two ends come to disagree
 * about what a merge is, and the server's copy is the one nobody watches.
 *
 * THE TWO MODES.
 *
 *   ffOnly   plays the whole sequence atomically — every patch applies, or the
 *            target branch does not move at all. This is the mode the server
 *            runs, unattended.
 *   default  plays patches until one needs a human decision, then stops with
 *            that conflict in a working tree for a person to resolve.
 *
 * `am` is NOT atomic: fail on patch five and patches one through four are
 * already on the branch. So both modes apply to a SCRATCH WORKTREE and the real
 * branch moves only once the whole sequence has landed. Without that, "atomic"
 * quietly means a half-applied branch — the one state the server must never be
 * able to reach. (Skip, 14:49:03: "Yes. Scratch ref. Of course.")
 *
 * MARCHING FORWARD IS THE REQUIRED BEHAVIOUR, not an implementation detail to
 * work around (Skip, 14:47:18). Patches are fed to `am` ONE AT A TIME rather
 * than as a queue, so a stop names the patch that stopped it and carries that
 * patch's own message and author. Collapsed into one diff, a person gets a
 * conflict against a blob and no way to tell which change caused it.
 *
 * THE SERVER NEVER RESOLVES ANYTHING. On a conflict in `ffOnly` this aborts,
 * removes the scratch worktree and reports. It hands off; it does not decide.
 */

import { execFile as execFileCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const execFile = promisify(execFileCb)

// The state a stopped merge leaves behind, and the patches it has not applied
// yet. It lives in the target repo's git directory rather than in `scratch/`
// because it is a RESUMPTION POINT — `tlda project merge --continue` works from it —
// and a resumption point that a tidy-up can delete is not one.
const STATE_FILE = 'tlda-merge.json'
const PATCH_DIR = 'tlda-merge-patches'

async function git(cwd, args, { timeout = 120000 } = {}) {
  try {
    const { stdout, stderr } = await execFile('git', args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 })
    return { stdout, stderr }
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim()
    const err = new Error(`git ${args.slice(0, 3).join(' ')} failed: ${detail}`)
    err.git = { args, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString(), code: e.code }
    throw err
  }
}

async function gitOut(cwd, args, opts) {
  const { stdout } = await git(cwd, args, opts)
  return stdout.trim()
}

/**
 * Build a patch-id index over a rev range in ONE pipe.
 *
 * A patch-id is a hash of the diff with whitespace and line numbers normalised,
 * so it is identical for two commits that make the same change whatever their
 * shas. That is exactly what this operation needs, because new shas on the
 * target side are expected and are not a problem to be solved (Skip, 14:36:34).
 * The technique is already in this tree, in bin/branch-landed.mjs, for the same
 * reason: `main` is assembled by cherry-pick, so shas differ there too.
 *
 * ONE pipe rather than a process per commit: bin/branch-landed.mjs measured the
 * per-commit form at roughly 15x slower, which is the difference between a
 * check that runs and one nobody enables.
 */
function patchIdPipe(cwd, revArgs) {
  return new Promise((resolve, reject) => {
    const log = spawn('git', ['log', '-p', '--no-color', '--no-textconv', '--no-merges', ...revArgs], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const ids = spawn('git', ['patch-id', '--stable'], { cwd, stdio: [log.stdout, 'pipe', 'ignore'] })
    let out = ''
    ids.stdout.on('data', chunk => { out += chunk })
    log.on('error', reject)
    ids.on('error', reject)
    ids.on('close', () => {
      const rows = []
      for (const line of out.split('\n')) {
        const [patchId, commit] = line.trim().split(/\s+/)
        if (patchId && commit) rows.push({ patchId, commit })
      }
      resolve(rows)
    })
  })
}

/**
 * Which source commits are not already on the target, oldest first.
 *
 * THE PATCH RANGE is listed as an open point in the spec — "what `format-patch`
 * takes as its base on the second and subsequent merge of the same project."
 * This does not choose between the alternatives it names; it falls out of the
 * matching rule that was already chosen. Matching is by patch-id, so the
 * commits still owed to the target are exactly the source commits whose
 * patch-id is not already present there. No base has to be remembered, nothing
 * has to be recorded on either side, and a second merge of the same project is
 * the same computation as the first. It is what `git cherry` does, for the same
 * reason.
 *
 * WHAT THIS CANNOT DO, stated rather than discovered later: a patch-id is a
 * hash of the diff, so a change that landed on the target in a different shape
 * — a conflict resolved by hand, a rebase that shifted context beyond the
 * normalisation — does not match, and this offers it again. It is wrong in the
 * safe direction (it re-offers rather than silently drops), and in the default
 * mode the person sees it stop on a patch that is already there and can
 * `am --skip` it.
 *
 * A commit with an EMPTY diff produces no patch-id line at all, so it cannot be
 * matched and cannot be replayed. Those are counted and reported rather than
 * dropped in silence — see `emptyCommits` in the result.
 */
export async function selectCommits({ sourceRepo, sourceRef, targetRepo, targetBranch }) {
  const onTarget = new Set((await patchIdPipe(targetRepo, [targetBranch])).map(r => r.patchId))
  const sourceRows = await patchIdPipe(sourceRepo, ['--reverse', sourceRef])

  const withDiff = new Set(sourceRows.map(r => r.commit))
  const allSource = (await gitOut(sourceRepo, ['rev-list', '--reverse', '--no-merges', sourceRef]))
    .split('\n').filter(Boolean)
  const emptyCommits = allSource.filter(sha => !withDiff.has(sha))

  const selected = []
  for (const row of sourceRows) {
    if (onTarget.has(row.patchId)) continue
    const subject = await gitOut(sourceRepo, ['log', '-1', '--format=%s', row.commit])
    const author = await gitOut(sourceRepo, ['log', '-1', '--format=%an <%ae>', row.commit])
    const date = await gitOut(sourceRepo, ['log', '-1', '--format=%aI', row.commit])
    selected.push({ commit: row.commit, patchId: row.patchId, subject, author, date })
  }
  return { selected, alreadyPresent: sourceRows.length - selected.length, emptyCommits, totalSource: allSource.length }
}

async function isRootCommit(repo, sha) {
  const parents = await gitOut(repo, ['rev-list', '--parents', '-n', '1', sha])
  return parents.trim().split(/\s+/).length === 1
}

/** Write one patch file per selected commit, in order, and return their paths. */
async function writePatches({ sourceRepo, selected, patchDir }) {
  mkdirSync(patchDir, { recursive: true })
  const paths = []
  for (let i = 0; i < selected.length; i++) {
    const { commit } = selected[i]
    const args = ['format-patch', '-1', '--stdout', '--no-signature', '--keep-subject', '--binary']
    if (await isRootCommit(sourceRepo, commit)) args.push('--root')
    args.push(commit)
    const { stdout } = await git(sourceRepo, args)
    const path = join(patchDir, `${String(i + 1).padStart(4, '0')}-${commit.slice(0, 7)}.patch`)
    writeFileSync(path, stdout)
    paths.push(path)
  }
  return paths
}

function gitDirOf(repo) {
  // The target's real git directory. `--git-dir` is resolved rather than
  // assumed to be `<repo>/.git`, because the target may itself be a worktree,
  // where `.git` is a file pointing elsewhere.
  return execFile('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo })
    .then(({ stdout }) => stdout.trim())
}

async function committerArgs(repo) {
  // `am` preserves the patch's AUTHOR but still needs a committer identity. A
  // repo without one errors out on the first patch, which reads as the patch
  // being bad. Supply a fallback only when the repo has none.
  try {
    await execFile('git', ['config', '--get', 'user.email'], { cwd: repo })
    return []
  } catch {
    return ['-c', 'user.email=tlda@local', '-c', 'user.name=tlda']
  }
}

/** Is an `am` paused in this worktree? */
async function amInProgress(worktree) {
  const path = await gitOut(worktree, ['rev-parse', '--git-path', 'rebase-apply'])
  const abs = path.startsWith('/') ? path : join(worktree, path)
  return existsSync(abs)
}

/**
 * Apply patches one at a time into the scratch worktree.
 * Returns { ok: true } or { ok: false, failedIndex, remaining, stderr }.
 */
async function applyPatches({ worktree, patches, identity, onProgress }) {
  for (let i = 0; i < patches.length; i++) {
    try {
      // `-k` pairs with `format-patch --keep-subject`: the patch carries the
      // commit's real subject with no `[PATCH]` prefix, so `am` must not strip
      // a bracket off the front of it. A subject that genuinely begins `[foo]`
      // is otherwise silently rewritten.
      await git(worktree, [...identity, 'am', '-k', '--3way', patches[i]])
      onProgress({ kind: 'applied', index: i, total: patches.length, patch: patches[i] })
    } catch (e) {
      return {
        ok: false,
        failedIndex: i,
        remaining: patches.slice(i + 1),
        stderr: (e.git?.stderr || e.message || '').toString(),
      }
    }
  }
  return { ok: true }
}

function readState(gitDir) {
  const path = join(gitDir, STATE_FILE)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeState(gitDir, state) {
  writeFileSync(join(gitDir, STATE_FILE), JSON.stringify(state, null, 2))
}

async function clearState(targetRepo, gitDir, sourceRefName = null) {
  const ref = sourceRefName || readState(gitDir)?.sourceRefName
  rmSync(join(gitDir, STATE_FILE), { force: true })
  rmSync(join(gitDir, PATCH_DIR), { force: true, recursive: true })
  // The borrowed objects go unreferenced and git reclaims them on its own
  // schedule. Nothing is deleted here that the target had before.
  if (ref) {
    try {
      await git(targetRepo, ['update-ref', '-d', ref])
    } catch {
      // The ref was never created, or somebody removed it. Either way it is
      // absent, which is the state this is trying to reach — and failing to
      // tidy a borrowed ref must not turn a landed merge into an error.
    }
  }
}

/**
 * Bring the source's objects into the target so `am --3way` can actually do a
 * three-way merge.
 *
 * WITHOUT THIS, A CONFLICT LEAVES A PERSON NOTHING TO RESOLVE. `--3way` needs
 * the patch's PREIMAGE blob, and a patch from the app's copy names blobs the
 * author's repository has never seen. Missing them, git falls back to a plain
 * apply, which fails outright: `am` stops, but the working tree is clean and
 * there are no conflict markers anywhere. Measured 2026-08-22 — the story test
 * caught it as "the conflict markers are in that working tree" failing while
 * every other assertion about stopping passed, which is exactly how this would
 * have shipped: it stops, it reports, and the thing it stopped for is not there.
 *
 * The fetch is a plain object copy under a ref of our own, removed when the
 * merge finishes or is dropped. It does not make the source a remote, and it
 * does not make the app's copy upstream of anything.
 */
async function borrowSourceObjects({ targetRepo, sourceRepo, sourceRef, refName }) {
  await git(targetRepo, ['fetch', '--no-tags', '--quiet', sourceRepo, `+${sourceRef}:${refName}`])
}

/**
 * Move the real branch to the finished tip.
 *
 * Two cases, and the difference is whether somebody could be standing in the
 * working tree:
 *
 *   not checked out   compare-and-swap the ref against the tip we started from.
 *                     A concurrent move loses the swap and fails loudly rather
 *                     than landing last and winning — the same rule the
 *                     accepted head uses.
 *   checked out       `git merge --ff-only`, which is git's own fast-forward and
 *                     refuses on its own if a local change would be overwritten.
 *                     Nothing here overwrites a file somebody is editing.
 *
 * "Checked out" is read from the target repository's own HEAD. **A branch
 * checked out in some OTHER linked worktree reads as not checked out**, so it
 * takes the compare-and-swap path and that worktree's index goes stale until
 * its owner runs `git status`. Stated rather than guarded: it is confusion
 * rather than loss, and the guard would mean parsing `git worktree list` on
 * every land to catch a case nobody has hit.
 */
async function landOnBranch({ targetRepo, targetBranch, oldTip, newTip }) {
  const checkedOut = await gitOut(targetRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
  if (checkedOut === targetBranch) {
    try {
      await git(targetRepo, ['merge', '--ff-only', newTip])
    } catch (e) {
      // git refused because an uncommitted change would be overwritten. That
      // refusal is the correct outcome and the message says which file — but
      // said as `git merge --ff-only failed` it reads as the merge being
      // broken, so name what actually happened. The replay is finished and
      // sitting at `newTip`; nothing is lost by saying no here.
      const err = new Error(
        `${targetBranch} is checked out and has uncommitted changes that this would overwrite. ` +
        `Nothing was applied. Commit or stash them and run it again.\n${(e.git?.stderr || e.message).trim()}`,
      )
      err.landRefused = true
      throw err
    }
    return { how: 'fast-forward in the checked-out branch' }
  }
  await git(targetRepo, ['update-ref', `refs/heads/${targetBranch}`, newTip, oldTip])
  return { how: 'compare-and-swap on the ref' }
}

async function removeWorktree(targetRepo, worktree) {
  try { await git(targetRepo, ['worktree', 'remove', '--force', worktree]) } catch {
    rmSync(worktree, { force: true, recursive: true })
    try {
      await git(targetRepo, ['worktree', 'prune'])
    } catch {
      // The directory is gone; prune only clears git's stale bookkeeping for
      // it. A stale entry is cosmetic and the next `worktree add` prunes
      // anyway, so this must not fail an otherwise finished operation.
    }
  }
}

/**
 * Replay `sourceRef` from `sourceRepo` onto `targetBranch` in `targetRepo`.
 *
 * Returns one of:
 *   { status: 'up-to-date' }                          nothing owed
 *   { status: 'merged', commits, newTip, how }         landed
 *   { status: 'conflict', ... }                        default mode, stopped for a human
 *   { status: 'refused', ... }                         ffOnly, could not play the whole sequence
 */
export async function mergeReplay({
  sourceRepo,
  sourceRef = 'HEAD',
  targetRepo,
  targetBranch = null,
  ffOnly = false,
  onProgress = () => {},
}) {
  if (!existsSync(sourceRepo)) throw new Error(`source repository not found: ${sourceRepo}`)
  if (!existsSync(targetRepo)) throw new Error(`target repository not found: ${targetRepo}`)

  const gitDir = await gitDirOf(targetRepo)
  if (readState(gitDir)) {
    throw new Error('a tlda project merge is already in progress here — finish it with `tlda project merge --continue`, or drop it with `tlda project merge --abort`')
  }

  const branch = targetBranch || await gitOut(targetRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') {
    throw new Error('the target repository is on a detached HEAD — name a branch with --into')
  }
  const oldTip = await gitOut(targetRepo, ['rev-parse', `refs/heads/${branch}`])

  const selection = await selectCommits({ sourceRepo, sourceRef, targetRepo, targetBranch: branch })
  onProgress({ kind: 'selected', ...selection })
  if (selection.selected.length === 0) {
    return { status: 'up-to-date', branch, ...selection }
  }

  const patchDir = join(gitDir, PATCH_DIR)
  rmSync(patchDir, { force: true, recursive: true })
  const patches = await writePatches({ sourceRepo, selected: selection.selected, patchDir })

  const sourceRefName = `refs/tlda/merge-source/${oldTip.slice(0, 7)}`
  await borrowSourceObjects({ targetRepo, sourceRepo, sourceRef, refName: sourceRefName })

  // The scratch worktree IS the clean copy of the target the patches are
  // replayed onto (Skip, 14:33:57). Detached, so no branch of the target's
  // exists in a half-applied state at any point.
  const worktree = join(gitDir, `tlda-merge-scratch-${oldTip.slice(0, 7)}`)
  rmSync(worktree, { force: true, recursive: true })
  await git(targetRepo, ['worktree', 'prune'])
  await git(targetRepo, ['worktree', 'add', '--detach', worktree, oldTip])

  const identity = await committerArgs(targetRepo)
  const applied = await applyPatches({ worktree, patches, identity, onProgress })

  if (!applied.ok) {
    const failed = selection.selected[applied.failedIndex]
    if (ffOnly) {
      // The server never resolves anything. Abort, take the scratch worktree
      // away, and leave the real branch exactly where it was.
      try {
        await git(worktree, ['am', '--abort'])
      } catch {
        // No am was in progress, or the abort itself failed. The whole scratch
        // worktree is removed on the next line regardless, and the real branch
        // was never touched, so there is nothing left for this to protect.
      }
      await removeWorktree(targetRepo, worktree)
      await clearState(targetRepo, gitDir, sourceRefName)
      return {
        status: 'refused',
        reason: 'not-fast-forward',
        branch,
        failedAt: { position: applied.failedIndex + 1, of: patches.length, ...failed },
        detail: applied.stderr,
        ...selection,
      }
    }
    writeState(gitDir, {
      worktree, branch, oldTip, patchDir, sourceRefName,
      remaining: applied.remaining,
      failedPatch: patches[applied.failedIndex],
      failedCommit: failed,
      identity,
    })
    return {
      status: 'conflict',
      branch,
      worktree,
      failedAt: { position: applied.failedIndex + 1, of: patches.length, ...failed },
      remaining: applied.remaining.length,
      detail: applied.stderr,
      ...selection,
    }
  }

  const newTip = await gitOut(worktree, ['rev-parse', 'HEAD'])
  let landed
  try {
    landed = await landOnBranch({ targetRepo, targetBranch: branch, oldTip, newTip })
  } catch (e) {
    // The branch did not move, so there is nothing half-done to preserve — and
    // leaving the scratch worktree and the state file behind would make the
    // NEXT run refuse with "a merge is already in progress" over a merge that
    // never happened. Clean up and let the operation be re-runnable.
    await removeWorktree(targetRepo, worktree)
    await clearState(targetRepo, gitDir, sourceRefName)
    throw e
  }
  await removeWorktree(targetRepo, worktree)
  await clearState(targetRepo, gitDir, sourceRefName)
  return { status: 'merged', branch, commits: patches.length, oldTip, newTip, how: landed.how, ...selection }
}

/**
 * Finish a merge that stopped for a human decision.
 *
 * A paused `am` lives in `.git/rebase-apply` on the box that paused it and is
 * not transportable (Skip, 14:48:18). So this is the same box, and what leaves
 * the box afterwards is a finished branch — never a half-applied merge.
 */
export async function mergeContinue({ targetRepo, onProgress = () => {} }) {
  const gitDir = await gitDirOf(targetRepo)
  const state = readState(gitDir)
  if (!state) throw new Error('no tlda project merge is in progress here')
  if (!existsSync(state.worktree)) {
    await clearState(targetRepo, gitDir)
    throw new Error(`the scratch worktree is gone (${state.worktree}) — nothing was landed; run the merge again`)
  }
  if (await amInProgress(state.worktree)) {
    throw new Error(
      `the conflicted patch is still open. Resolve it in ${state.worktree}, then:\n` +
      `  git -C ${state.worktree} am --continue     (or --skip to drop that patch)\n` +
      'then run `tlda project merge --continue` again.',
    )
  }

  const applied = await applyPatches({
    worktree: state.worktree, patches: state.remaining, identity: state.identity || [], onProgress,
  })
  if (!applied.ok) {
    writeState(gitDir, { ...state, remaining: applied.remaining, failedPatch: state.remaining[applied.failedIndex] })
    return {
      status: 'conflict',
      branch: state.branch,
      worktree: state.worktree,
      remaining: applied.remaining.length,
      detail: applied.stderr,
    }
  }

  // Deliberately NOT wrapped the way mergeReplay's landing is. There, a failed
  // landing has nothing worth keeping and the state file would only wedge the
  // next run. Here the scratch worktree holds a person's conflict resolution,
  // which exists nowhere else — so a failed landing keeps everything and they
  // can fix the reason and run `--continue` again.
  const newTip = await gitOut(state.worktree, ['rev-parse', 'HEAD'])
  const currentTip = await gitOut(targetRepo, ['rev-parse', `refs/heads/${state.branch}`])
  const landed = await landOnBranch({
    targetRepo, targetBranch: state.branch, oldTip: currentTip, newTip,
  })
  await removeWorktree(targetRepo, state.worktree)
  await clearState(targetRepo, gitDir)
  return { status: 'merged', branch: state.branch, newTip, how: landed.how }
}

/** Drop a stopped merge. The real branch was never moved, so there is nothing to undo. */
export async function mergeAbort({ targetRepo }) {
  const gitDir = await gitDirOf(targetRepo)
  const state = readState(gitDir)
  if (!state) throw new Error('no tlda project merge is in progress here')
  if (existsSync(state.worktree)) {
    try {
      await git(state.worktree, ['am', '--abort'])
    } catch {
      // Same as the refusal path: the scratch worktree goes away next line and
      // the real branch never moved, so an abort that cannot run costs nothing.
      // Dropping a merge must not itself be a thing that can fail.
    }
    await removeWorktree(targetRepo, state.worktree)
  }
  await clearState(targetRepo, gitDir)
  return { status: 'aborted', branch: state.branch }
}

/** Is a merge stopped here? Used by the CLI to report before it starts a new one. */
export async function mergeStatus({ targetRepo }) {
  const gitDir = await gitDirOf(targetRepo)
  const state = readState(gitDir)
  if (!state) return { status: 'idle' }
  return {
    status: 'stopped',
    branch: state.branch,
    worktree: state.worktree,
    remaining: state.remaining.length,
    failedCommit: state.failedCommit,
    amOpen: existsSync(state.worktree) ? await amInProgress(state.worktree) : false,
  }
}
