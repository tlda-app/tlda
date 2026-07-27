/**
 * tlda repo-doctor — diagnose (and eventually rescue) a project's source repo
 * after it has accumulated tlda-generated commits on the user's branch.
 *
 * Background: prior to commit b317ecc, the build pipeline did
 * `git reset --mixed <shadow-hash>` inside the user's source repo on every
 * successful build, silently moving the user's branch ref onto the shadow's
 * history line. After hundreds of builds a repo's `master` is on a
 * tlda@local "Build at …" line with no common ancestor with `origin`, so
 * `git pull origin` reports "unrelated histories" and any external merge
 * (e.g. from Overleaf) gets clobbered by the next build.
 *
 * Phase 1 (this file): diagnose-only. Read state, report findings, take no
 * action. Phase 2 will add an interactive --rescue mode.
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// The CLI runs without a server context, so we read the project's JSON
// directly rather than going through the project-store (which needs init).
const SERVER_PROJECTS_DIR = process.env.TLDA_PROJECTS_DIR
  || join(homedir(), 'work', 'tlda', 'server', 'projects')

function readProjectJson(name) {
  const path = join(SERVER_PROJECTS_DIR, name, 'project.json')
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

const TLDA_EMAIL_RE = /^tlda@local$/i
const BUILD_AT_RE = /^Build at /

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trimEnd()
  } catch {
    return null
  }
}

// Variant that returns stdout even when the command exits non-zero. Used
// for commands like `git merge-tree` whose non-zero exit can be a normal
// outcome (e.g. exit 1 = conflicts, but stdout still contains the result).
function shAllowFail(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trimEnd()
  } catch (e) {
    if (e?.stdout != null) return String(e.stdout).trimEnd()
    return null
  }
}

// Variant that returns a structured result including stderr on failure,
// so callers can surface meaningful diagnostics instead of swallowing
// errors. Used in the --apply path.
function shResult(cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    return { ok: true, stdout: String(stdout).trimEnd(), stderr: '' }
  } catch (e) {
    return {
      ok: false,
      stdout: e?.stdout != null ? String(e.stdout).trimEnd() : '',
      stderr: e?.stderr != null ? String(e.stderr).trim() : (e?.message || ''),
      code: e?.status,
    }
  }
}

function inRepo(repo) {
  return (cmd) => sh(`git -C "${repo}" ${cmd}`)
}

/**
 * Walk back from HEAD until we find a commit whose author is NOT tlda@local.
 * Returns the commit info or null if we hit the root.
 */
function findLastRealCommit(g) {
  const log = g('log --format=%H%x09%ae%x09%at%x09%s -n 5000')
  if (!log) return null
  for (const line of log.split('\n')) {
    const [hash, email, ts, ...subj] = line.split('\t')
    if (email && !TLDA_EMAIL_RE.test(email)) {
      return { hash, email, ts: parseInt(ts, 10) * 1000, subject: subj.join('\t') }
    }
  }
  return null
}

/**
 * Count commits on HEAD that look like tlda snapshot commits ("Build at …"
 * by tlda@local) since divergence from origin.
 */
function countShadowCommitsAhead(g, originRef) {
  // Get commits on HEAD that are not on originRef. If unrelated histories,
  // this is just the full HEAD history.
  const mb = g(`merge-base HEAD ${originRef}`)
  const range = mb ? `${mb}..HEAD` : 'HEAD'
  const log = g(`log --format=%ae%x09%s ${range}`)
  if (!log) return { total: 0, shadow: 0, real: 0, unrelated: !mb }
  const lines = log.split('\n').filter(Boolean)
  let shadow = 0
  let real = 0
  for (const line of lines) {
    const [email, ...subj] = line.split('\t')
    const s = subj.join('\t')
    if (TLDA_EMAIL_RE.test(email) && BUILD_AT_RE.test(s)) shadow++
    else real++
  }
  return { total: lines.length, shadow, real, unrelated: !mb }
}

/**
 * Inspect the working tree for state that may interfere with rescue:
 * leftover .merge-bak dirs, files with conflict markers, etc.
 */
function inspectWorkingTree(g, repo) {
  const status = g('status --porcelain') || ''
  const lines = status.split('\n').filter(Boolean)
  const modified = lines.filter(l => /^.[M ]/.test(l)).length
  const untracked = lines.filter(l => l.startsWith('??')).length
  const staged = lines.filter(l => /^[MADRCU] /.test(l)).length
  const conflicted = lines.filter(l => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l)).length

  // Look for likely-leftover directories
  const leftoverDirs = []
  const candidates = sh(`ls -1 "${repo}" 2>/dev/null`) || ''
  for (const entry of candidates.split('\n')) {
    if (/^\.merge-bak-/.test(entry) || /^backup-pre-/.test(entry)) {
      leftoverDirs.push(entry)
    }
  }

  return { modified, untracked, staged, conflicted, leftoverDirs }
}

export async function diagnose(projectName, opts = {}) {
  const project = readProjectJson(projectName)
  if (!project) {
    return { ok: false, error: `Project "${projectName}" not found` }
  }
  if (!project.sourceDir) {
    return { ok: false, error: `Project "${projectName}" has no sourceDir set` }
  }
  if (!existsSync(join(project.sourceDir, '.git'))) {
    return { ok: false, error: `${project.sourceDir} is not a git repo` }
  }

  const g = inRepo(project.sourceDir)

  // ── Current branch + HEAD ────────────────────────────────────────────────
  const branch = g('symbolic-ref --short HEAD') || '(detached)'
  const headHash = g('rev-parse HEAD')
  const headInfo = g(`log -1 --format=%ae%x09%at%x09%s HEAD`) || ''
  const [headEmail, headTs, ...headSubjParts] = headInfo.split('\t')
  const head = {
    hash: headHash,
    email: headEmail,
    ts: parseInt(headTs, 10) * 1000,
    subject: headSubjParts.join('\t'),
    isShadow: TLDA_EMAIL_RE.test(headEmail) && BUILD_AT_RE.test(headSubjParts.join('\t')),
  }

  // ── Remotes ──────────────────────────────────────────────────────────────
  const remotes = {}
  const remoteList = (g('remote') || '').split('\n').filter(Boolean)
  for (const r of remoteList) {
    remotes[r] = g(`remote get-url ${r}`)
  }

  // Pick the "upstream" remote: origin if present, else first non-tlda-shadow.
  const upstreamName = remotes.origin ? 'origin'
    : remoteList.find(r => r !== 'tlda-shadow') || null
  let upstream = null
  if (upstreamName) {
    const refList = (g(`for-each-ref --format='%(refname)' refs/remotes/${upstreamName}/`) || '').split('\n').filter(Boolean)
    // Prefer <upstream>/<branch>; fall back to <upstream>/HEAD's target.
    const want = `refs/remotes/${upstreamName}/${branch}`
    const ref = refList.find(r => r === want) || refList[0] || null
    if (ref) {
      const info = g(`log -1 --format=%H%x09%ae%x09%at%x09%s ${ref}`) || ''
      const [uHash, uEmail, uTs, ...uSubj] = info.split('\t')
      upstream = {
        ref,
        hash: uHash,
        email: uEmail,
        ts: parseInt(uTs, 10) * 1000,
        subject: uSubj.join('\t'),
      }
    }
  }

  // ── Branch history vs upstream ───────────────────────────────────────────
  const counts = upstream ? countShadowCommitsAhead(g, upstream.ref) : { total: 0, shadow: 0, real: 0, unrelated: true }
  const lastReal = findLastRealCommit(g)

  // ── Working tree ─────────────────────────────────────────────────────────
  const wt = inspectWorkingTree(g, project.sourceDir)

  // ── Shadow integration ───────────────────────────────────────────────────
  const tagCount = parseInt(g(`tag --list 'shadow/*' | wc -l`) || '0', 10)
  const latestTag = g(`tag --list 'shadow/*' --sort=-creatordate | head -1`) || null
  const tldaShadowHead = g('rev-parse refs/tlda/shadow/HEAD') || null

  // ── Diagnosis verdict ────────────────────────────────────────────────────
  const issues = []
  if (head.isShadow) issues.push('HEAD is a tlda-generated snapshot commit, not real work')
  if (counts.unrelated && upstream) issues.push(`No common ancestor with ${upstream.ref}`)
  if (counts.shadow > 0) issues.push(`${counts.shadow} tlda "Build at" commits on this branch since divergence`)
  if (counts.real > 0 && counts.shadow > 0) issues.push(`${counts.real} real commits are interleaved with shadow commits — rescue will need to cherry-pick`)
  if (wt.leftoverDirs.length) issues.push(`Leftover backup/merge dirs: ${wt.leftoverDirs.join(', ')}`)
  if (wt.conflicted > 0) issues.push(`${wt.conflicted} files in conflicted state`)

  return {
    ok: true,
    project: projectName,
    sourceDir: project.sourceDir,
    branch,
    head,
    remotes,
    upstream,
    counts,
    lastReal,
    workingTree: wt,
    shadow: { tagCount, latestTag, tldaShadowHead },
    issues,
  }
}

/**
 * Find a content-equivalent fork point between the user's branch and the
 * upstream branch, by matching tree hashes. The two branches' commits have
 * different SHAs (the filter-repo / tlda paths rewrote them), but commits
 * with identical paper content have identical tree hashes — those are the
 * de-facto common ancestors.
 *
 * Returns the most-recent matching pair { local, origin } (by origin's
 * timestamp), or null if no match found within the searched window.
 */
function parseLogLine(line) {
  // %H %T %ae %at %s — tab-separated
  const [hash, tree, email, ts, ...subj] = line.split('\t')
  return { hash, tree, email, ts: parseInt(ts, 10) * 1000, subject: subj.join('\t') }
}

export function findContentFork(g, originRef, opts = {}) {
  const limit = opts.limit || 2000
  const localLog = g(`log --format='%H%x09%T%x09%ae%x09%at%x09%s' -n ${limit} HEAD`)
  const originLog = g(`log --format='%H%x09%T%x09%ae%x09%at%x09%s' -n ${limit} ${originRef}`)
  if (!localLog || !originLog) return null

  const localCommits = localLog.split('\n').filter(Boolean).map(parseLogLine)
  const originCommits = originLog.split('\n').filter(Boolean).map(parseLogLine)

  // Index origin commits by tree-hash (keep first = most recent occurrence).
  const originByTree = new Map()
  for (const c of originCommits) {
    if (!originByTree.has(c.tree)) originByTree.set(c.tree, c)
  }

  // Walk local commits newest-first; first match wins.
  for (const local of localCommits) {
    const origin = originByTree.get(local.tree)
    if (origin) return { local, origin, matchType: 'tree' }
  }
  return null
}

/**
 * Read paper-scope file paths from the server's relevant-files.json,
 * normalized to be relative to the user's sourceDir. These are the files
 * pdflatex actually opened in the last build — bib/svg are included by
 * writeRelevantFiles in build-runner.mjs.
 */
function readPaperScopePaths(projectName) {
  const path = join(SERVER_PROJECTS_DIR, projectName, 'output', 'relevant-files.json')
  if (!existsSync(path)) return null
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  if (!Array.isArray(parsed?.files)) return null
  // Scope is project-relative — already in the working copy's own space.
  const out = new Set(parsed.files.filter(p => typeof p === 'string' && p.length > 0))
  return out.size === 0 ? null : [...out].sort()
}

/**
 * Compute a stable signature of a commit's tree for a fixed list of paths:
 * sorted `path:blob_hash` joined with newlines. Two commits with the same
 * signature have byte-identical content for those paths, even if their
 * top-level trees differ (because of paths outside the scope).
 *
 * Paths not present in a commit are treated as "missing" sentinel, so
 * commits missing some scope files don't accidentally match commits that
 * have them.
 */
function paperScopeSignature(g, commitHash, paths) {
  const pathList = paths.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ')
  const out = g(`ls-tree --full-tree -r ${commitHash} -- ${pathList}`)
  if (out === null) return null
  // ls-tree output: `<mode> <type> <hash>\t<path>`
  const blobByPath = new Map()
  for (const line of out.split('\n')) {
    if (!line) continue
    const tabIdx = line.indexOf('\t')
    if (tabIdx < 0) continue
    const fields = line.slice(0, tabIdx).split(' ')
    const path = line.slice(tabIdx + 1)
    if (fields.length < 3) continue
    if (fields[1] !== 'blob') continue
    blobByPath.set(path, fields[2])
  }
  return paths.map(p => `${p}:${blobByPath.get(p) || '_MISSING_'}`).join('\n')
}

/**
 * Find a content-fork point by paper-scope signature: walk both histories,
 * compute the signature of paper-scope files only, find a matching pair.
 * Falls back to whole-tree match if no paper-scope is provided.
 */
export function findPaperScopeFork(g, originRef, paperScope, opts = {}) {
  if (!paperScope || paperScope.length === 0) return null
  const limit = opts.limit || 1000
  const localLog = g(`log --format='%H%x09%T%x09%ae%x09%at%x09%s' -n ${limit} HEAD`)
  const originLog = g(`log --format='%H%x09%T%x09%ae%x09%at%x09%s' -n ${limit} ${originRef}`)
  if (!localLog || !originLog) return null

  const localCommits = localLog.split('\n').filter(Boolean).map(parseLogLine)
  const originCommits = originLog.split('\n').filter(Boolean).map(parseLogLine)

  // Build origin signature index. Skip signatures where every path is missing
  // (those would match any other "all missing" commit, which is meaningless).
  const originBySig = new Map()
  for (const c of originCommits) {
    const sig = paperScopeSignature(g, c.hash, paperScope)
    if (!sig || /^[^:]+:_MISSING_(\n[^:]+:_MISSING_)*$/.test(sig)) continue
    if (!originBySig.has(sig)) originBySig.set(sig, c)
  }

  // Walk local commits newest-first; first match wins.
  for (const local of localCommits) {
    const sig = paperScopeSignature(g, local.hash, paperScope)
    if (!sig) continue
    const origin = originBySig.get(sig)
    if (origin) return { local, origin, matchType: 'paper-scope' }
  }
  return null
}

/**
 * Compute the rescue plan: find the content-fork point, summarize what
 * three-way merge would touch, and list the steps. Read-only.
 *
 * Returns { ok, fork, mergeSummary, plan } or { ok: false, error }.
 *
 * mergeSummary uses `git merge-tree --write-tree` (modern git plumbing) to
 * dry-run the three-way merge between the user's working-copy tree, the
 * fork's tree as base, and origin's tree, reporting conflicts by file.
 */
export async function rescuePlan(projectName) {
  const diag = await diagnose(projectName)
  if (!diag.ok) return { ok: false, error: diag.error }
  if (!diag.upstream) return { ok: false, error: `No upstream remote — nothing to rescue against.`, diag }

  const g = inRepo(diag.sourceDir)
  // Prefer paper-scope signature matching (handles cases like synth-supplement
  // where local trees are paper-scope-only but origin trees include
  // figures/etc., so whole-tree hashes never match even on the same paper
  // content). Fall back to whole-tree match if no paper-scope is available.
  const paperScope = readPaperScopePaths(projectName)
  let fork = null
  if (paperScope) {
    fork = findPaperScopeFork(g, diag.upstream.ref, paperScope)
  }
  if (!fork) {
    fork = findContentFork(g, diag.upstream.ref)
  }
  if (!fork) {
    return {
      ok: false,
      error: paperScope
        ? `No content-fork point found by paper-scope signature (${paperScope.length} files) or whole-tree hash. The repos may have genuinely diverged.`
        : `No content-fork point found by whole-tree hash and no paper-scope available (run a build first to generate output/relevant-files.json).`,
      diag,
    }
  }

  // Capture working-tree state as a tree object WITHOUT modifying the user's
  // index. Use a temporary GIT_INDEX_FILE so the real index stays untouched.
  const tmpIdx = `/tmp/tlda-rescue-idx-${process.pid}-${Date.now()}`
  let workTreeHash = null
  try {
    // Build the temp index from the current HEAD's tree, then update it to
    // include working-tree modifications (no .gitignore'd files, no removals
    // that aren't already staged — keep this conservative).
    sh(`GIT_INDEX_FILE="${tmpIdx}" git -C "${diag.sourceDir}" read-tree HEAD`)
    sh(`GIT_INDEX_FILE="${tmpIdx}" git -C "${diag.sourceDir}" add -u`)
    workTreeHash = sh(`GIT_INDEX_FILE="${tmpIdx}" git -C "${diag.sourceDir}" write-tree`)
  } finally {
    sh(`rm -f "${tmpIdx}"`)
  }
  if (!workTreeHash) {
    return { ok: false, error: 'Failed to capture working-tree state', diag, fork }
  }

  // Dry-run the three-way merge. `git merge-tree --write-tree` finds its
  // own merge-base from the two commits passed; we need that base to be the
  // origin-side fork commit. To arrange this without modifying refs we
  // create a dangling commit-object with parent = fork.origin.hash and tree
  // = workTreeHash. git's merge-base machinery then resolves to fork.origin
  // for the merge.
  const fakeOursCommit = sh(`git -C "${diag.sourceDir}" -c user.email=tlda-rescue@local -c user.name=tlda-rescue commit-tree -p "${fork.origin.hash}" -m "rescue-ours (dry-run)" "${workTreeHash}"`)
  if (!fakeOursCommit) {
    return { ok: false, error: 'Failed to construct dry-run ours commit', diag, fork }
  }
  // merge-tree exits 0 on clean merge, 1 on conflicts. Output on stdout:
  // line 1 = result tree hash (always present).
  // Subsequent lines (before the blank separator) = conflicted file paths
  // (with --name-only). After blank line: informational/conflict messages
  // (with --messages).
  const mergeOut = shAllowFail(`git -C "${diag.sourceDir}" merge-tree --write-tree --name-only --messages "${fakeOursCommit}" "${diag.upstream.hash}"`) || ''
  const blocks = mergeOut.split(/\n\n/)
  const headerLines = (blocks[0] || '').split('\n').filter(Boolean)
  const mergeResultTree = headerLines[0]?.match(/^[0-9a-f]{40}$/) ? headerLines[0] : null
  const conflictedFiles = headerLines.slice(1)
  const mergeMessages = blocks.slice(1).join('\n\n')
  const cleanMerge = mergeResultTree && conflictedFiles.length === 0

  // Summarize: count files that differ between (fork) and (work-tree),
  // (fork) and (origin), and overlap.
  const filesYours = (g(`diff --name-only ${fork.local.hash} ${workTreeHash}`) || '').split('\n').filter(Boolean)
  const filesTheirs = (g(`diff --name-only ${fork.origin.hash} ${diag.upstream.hash}`) || '').split('\n').filter(Boolean)
  const yoursSet = new Set(filesYours)
  const theirsSet = new Set(filesTheirs)
  const overlap = filesYours.filter(p => theirsSet.has(p))

  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const backupBranch = `pre-rescue-${diag.branch}-${ts}`
  const rescueBranchName = `rescue-${diag.branch}-${ts}`

  const plan = [
    `git fetch ${diag.upstream.ref.split('/')[2]}  (read-only)`,
    `git branch ${backupBranch} ${diag.head.hash.slice(0,7)}  (save current tip)`,
    `git update-ref refs/rescue-base ${fork.origin.hash}  (mark origin-side fork commit)`,
    `git checkout -b ${rescueBranchName} ${fork.origin.hash}  (start rescue branch at content-fork on origin's chain)`,
    `# Replay working tree onto rescue branch:`,
    `git read-tree --reset -u ${workTreeHash}  (apply user's working-tree to index + working tree)`,
    `git commit -m "Local work at $(date -Iseconds)"  (capture as a real commit on rescue branch)`,
    `git merge --no-commit --no-ff ${diag.upstream.ref}  (3-way merge with origin/master)`,
    `# At this point: rescue branch contains the merge; user resolves conflicts in WT`,
    `# then commits manually. master can be fast-forwarded to rescue branch when ready.`,
  ]

  return {
    ok: true,
    diag,
    fork,
    backupBranch,
    rescueBranchName,
    workTreeHash,
    mergeResultTree,
    conflictedFiles,
    cleanMerge,
    mergeMessages,
    summary: {
      yoursChanged: filesYours.length,
      theirsChanged: filesTheirs.length,
      bothTouched: overlap.length,
    },
    plan,
  }
}

/**
 * Execute the rescue plan computed by rescuePlan(). Re-captures the
 * current working-tree state at apply-time (the dry-run's tree may be
 * stale if the user has edited since). Stops on the first failure.
 *
 * Pre-flight: refuse to run if the working repo is in the middle of a
 * merge/rebase/cherry-pick. The user has to resolve that state first.
 */
export async function applyRescue(projectName, opts = {}) {
  const plan = await rescuePlan(projectName)
  if (!plan.ok) return plan

  const g = inRepo(plan.diag.sourceDir)

  // Pre-flight: refuse to apply if a merge/rebase/cherry-pick is in progress.
  const gitDir = sh(`git -C "${plan.diag.sourceDir}" rev-parse --git-dir`)
  if (!gitDir) return { ok: false, error: 'Could not locate .git directory' }
  const gitDirAbs = gitDir.startsWith('/') ? gitDir : join(plan.diag.sourceDir, gitDir)
  const inProgress = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
  ].find(([name]) => existsSync(join(gitDirAbs, name)))
  if (inProgress) {
    return { ok: false, error: `Refusing to apply: a ${inProgress[1]} is already in progress in ${plan.diag.sourceDir}` }
  }

  // Re-capture work-tree tree at apply time.
  const tmpIdx = `/tmp/tlda-rescue-apply-idx-${process.pid}-${Date.now()}`
  let workTreeHash = null
  try {
    sh(`GIT_INDEX_FILE="${tmpIdx}" git -C "${plan.diag.sourceDir}" read-tree HEAD`)
    // -A captures EVERYTHING on disk (respecting .gitignore), including
    // files the user has on disk but never committed. Critical for repos
    // whose tracked tree was filter-repo'd to a subset of what's on disk —
    // without -A, untracked files vanish from the rescue commit and the
    // subsequent merge refuses to overlay because they'd "overwrite
    // untracked files".
    sh(`GIT_INDEX_FILE="${tmpIdx}" git -C "${plan.diag.sourceDir}" add -A`)
    workTreeHash = sh(`GIT_INDEX_FILE="${tmpIdx}" git -C "${plan.diag.sourceDir}" write-tree`)
  } finally {
    sh(`rm -f "${tmpIdx}"`)
  }
  if (!workTreeHash) {
    return { ok: false, error: 'Failed to capture working-tree state at apply time' }
  }

  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const backupBranch = `pre-rescue-${plan.diag.branch}-${ts}`
  const rescueBranch = `rescue-${plan.diag.branch}-${ts}`
  const upstreamName = plan.diag.upstream.ref.replace(/^refs\/remotes\//, '').split('/')[0]

  const log = opts.log || ((msg) => console.log(`[rescue] ${msg}`))

  // Find untracked files that exist on disk AND are tracked at the upstream
  // tip. These would block the merge ("would overwrite untracked files").
  // We add+commit them on the rescue branch so the merge sees them as
  // committed-on-our-side rather than as untracked obstacles. Files that
  // are untracked AND not present on upstream are left alone (Skip's rule:
  // if neither side tracks them, they stay untracked).
  const upstreamPaths = new Set(
    (sh(`git -C "${plan.diag.sourceDir}" ls-tree -r --name-only "${plan.diag.upstream.ref}"`) || '')
      .split('\n').filter(Boolean)
  )
  const untrackedLines = (sh(`git -C "${plan.diag.sourceDir}" ls-files --others --exclude-standard`) || '')
    .split('\n').filter(Boolean)
  const promotePaths = untrackedLines.filter(p => upstreamPaths.has(p))

  const steps = [
    ['fetch-upstream', `fetch ${upstreamName}`],
    ['save-tip',       `branch ${backupBranch} ${plan.diag.head.hash}`],
    ['mark-fork',      `update-ref refs/rescue-base ${plan.fork.origin.hash}`],
    // Branch off current tip — no file movement, no checkout overhead.
    // `master` ref is unmoved; HEAD now points at the new rescue branch.
    ['rescue-branch',  `checkout -b ${rescueBranch}`],
    // Stage modifications to ALREADY-tracked files. Without this the
    // merge would refuse because dirty working tree.
    ['stage-modifications', `add -u`],
  ]
  if (promotePaths.length) {
    // Stage upstream-tracked-but-locally-untracked files (your local
    // versions of files origin already tracks).
    steps.push(['stage-untracked', `add -- ${promotePaths.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ')}`])
  }
  // Commit whatever's staged onto rescue branch so the index is clean
  // before the merge starts. `--allow-empty` covers the case where
  // nothing was staged (no untracked promotions, no tracked
  // modifications).
  steps.push(['commit-local-state',
    `-c user.name=tlda-rescue -c user.email=tlda-rescue@local commit --allow-empty -m "Local work captured at ${ts}"`])
  // Graft the local fork commit onto the origin fork commit so git's
  // merge-base algorithm finds origin's fork as the common ancestor.
  // Reversible with `git replace -d`.
  steps.push(['graft-fork', `replace --graft ${plan.fork.local.hash} ${plan.fork.origin.hash}`])
  // 3-way merge using grafted fork as base. Conflicts surface as diff3
  // markers in the working tree for Skip to resolve in Zed.
  steps.push(['merge', `merge --no-commit --no-ff ${plan.diag.upstream.ref}`])

  const completed = []
  for (const [label, cmd] of steps) {
    log(`${label}: git ${cmd}`)
    const res = shResult(`git -C "${plan.diag.sourceDir}" ${cmd}`)
    // `merge` is expected to exit non-zero on conflicts — that's a normal
    // outcome we want to keep walking past.
    const ok = res.ok || (label === 'merge' && /CONFLICT|Automatic merge failed/i.test(res.stderr + res.stdout))
    if (!ok) {
      return {
        ok: false,
        error: `Step "${label}" failed (exit ${res.code ?? '?'}):\n${res.stderr || res.stdout || '(no output)'}`,
        completed,
        backupBranch,
      }
    }
    completed.push({ label, out: res.stdout, stderr: res.stderr })
  }

  // Report conflicted files actually surfaced by the live merge.
  const conflictListing = sh(`git -C "${plan.diag.sourceDir}" diff --name-only --diff-filter=U`) || ''
  const liveConflicted = conflictListing.split('\n').filter(Boolean)
  const inMerge = existsSync(join(gitDirAbs, 'MERGE_HEAD'))

  return {
    ok: true,
    completed,
    backupBranch,
    workTreeHash,
    fork: plan.fork,
    conflictedFiles: liveConflicted,
    inMerge,
    sourceDir: plan.diag.sourceDir,
    branch: plan.diag.branch,
  }
}

/**
 * Roll back a partial rescue: if HEAD is currently on a `rescue-…` branch,
 * move HEAD back to the original branch (read from the matching
 * `pre-rescue-…` backup) and realign the index. Working tree is NOT
 * touched.
 *
 * Optionally deletes the rescue branch and the backup branch (opts.deleteRefs).
 */
export async function rollbackRescue(projectName, opts = {}) {
  const project = readProjectJson(projectName)
  if (!project?.sourceDir) return { ok: false, error: `Project "${projectName}" not found / no sourceDir` }
  const g = inRepo(project.sourceDir)
  const headRef = g('symbolic-ref HEAD') // e.g. refs/heads/rescue-master-...
  if (!headRef || !/^refs\/heads\/rescue-/.test(headRef)) {
    return { ok: false, error: `HEAD is ${headRef || '(detached)'} — not a rescue branch, nothing to roll back.` }
  }
  // rescue-<branch>-<ts> → original branch is <branch>; backup is pre-rescue-<branch>-<ts>
  const m = headRef.match(/^refs\/heads\/rescue-(.+?)-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})$/)
  if (!m) return { ok: false, error: `Unrecognized rescue branch format: ${headRef}` }
  const originalBranch = m[1]
  const ts = m[2]
  const backupBranch = `pre-rescue-${originalBranch}-${ts}`
  const backupHash = g(`rev-parse refs/heads/${backupBranch}`)
  if (!backupHash) return { ok: false, error: `Backup branch ${backupBranch} not found — can't roll back safely.` }

  // 1. Move HEAD back to original branch (symbolic-ref doesn't touch files).
  const r1 = shResult(`git -C "${project.sourceDir}" symbolic-ref HEAD refs/heads/${originalBranch}`)
  if (!r1.ok) return { ok: false, error: `symbolic-ref failed: ${r1.stderr}` }
  // 2. Realign index to original branch's tree. Working tree untouched.
  const r2 = shResult(`git -C "${project.sourceDir}" reset --mixed refs/heads/${originalBranch}`)
  if (!r2.ok) return { ok: false, error: `reset --mixed failed: ${r2.stderr}` }

  const rescueBranchRef = headRef.replace(/^refs\//, '')
  const deleted = []
  if (opts.deleteRefs) {
    for (const ref of [rescueBranchRef.replace(/^heads\//, ''), backupBranch]) {
      const d = shResult(`git -C "${project.sourceDir}" branch -D ${ref}`)
      if (d.ok) deleted.push(ref)
    }
    sh(`git -C "${project.sourceDir}" update-ref -d refs/rescue-base`)
  }

  return {
    ok: true,
    sourceDir: project.sourceDir,
    rolledBackFrom: rescueBranchRef.replace(/^heads\//, ''),
    rolledBackTo: originalBranch,
    deletedRefs: deleted,
  }
}

/**
 * Clean up a partial apply that left the user on their original branch
 * but with staged changes / leftover graft / leftover MERGE_HEAD. Resets
 * the index, deletes any replace refs we wrote, aborts any in-progress
 * merge. Working tree is NOT touched.
 */
export async function cleanupApplyState(projectName, opts = {}) {
  const project = readProjectJson(projectName)
  if (!project?.sourceDir) return { ok: false, error: `Project "${projectName}" not found / no sourceDir` }

  const cwd = project.sourceDir
  const did = []
  const targetBranch = opts.targetBranch || 'master'

  // 0. If HEAD is on a rescue-* branch, move it back to the target branch
  // (default master) first. symbolic-ref doesn't touch files.
  const currentHead = sh(`git -C "${cwd}" symbolic-ref HEAD 2>/dev/null`) || ''
  if (/^refs\/heads\/rescue-/.test(currentHead)) {
    const r0 = shResult(`git -C "${cwd}" symbolic-ref HEAD refs/heads/${targetBranch}`)
    if (r0.ok) did.push(`HEAD ${currentHead.replace(/^refs\/heads\//, '')} → ${targetBranch}`)
  }

  // 1. If a merge is in progress, abort it (but `--abort` will try to reset
  // working tree to ORIG_HEAD's tree, which can fail on untracked-overwrite
  // again). Safer: clear MERGE_HEAD/MERGE_MSG manually.
  const gitDir = sh(`git -C "${cwd}" rev-parse --git-dir`)
  const gitDirAbs = gitDir?.startsWith('/') ? gitDir : join(cwd, gitDir || '.git')
  for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'AUTO_MERGE']) {
    const p = join(gitDirAbs, f)
    if (existsSync(p)) {
      try { sh(`rm -f "${p}"`); did.push(`cleared ${f}`) } catch {}
    }
  }

  // 2. Unstage any staged changes (reset index to HEAD). Working tree
  // untouched.
  const headRef = sh(`git -C "${cwd}" symbolic-ref HEAD`)?.replace(/^refs\/heads\//, '') || 'HEAD'
  const r2 = shResult(`git -C "${cwd}" reset --mixed`)
  if (r2.ok) did.push(`unstaged index → ${headRef}`)

  // 3. Remove any `git replace` grafts we added.
  const replaceList = sh(`git -C "${cwd}" replace --list`) || ''
  for (const ref of replaceList.split('\n').filter(Boolean)) {
    const d = shResult(`git -C "${cwd}" replace -d ${ref}`)
    if (d.ok) did.push(`removed graft ${ref.slice(0,7)}`)
  }

  // 4. Remove rescue-base ref if present.
  if (sh(`git -C "${cwd}" rev-parse refs/rescue-base 2>/dev/null`)) {
    sh(`git -C "${cwd}" update-ref -d refs/rescue-base`)
    did.push('removed refs/rescue-base')
  }

  // 5. Optionally delete stale rescue-* and pre-rescue-* branches.
  if (opts.deleteRescueBranches) {
    const stale = (sh(`git -C "${cwd}" for-each-ref --format='%(refname:short)' 'refs/heads/rescue-*' 'refs/heads/pre-rescue-*'`) || '')
      .split('\n').filter(Boolean)
    for (const b of stale) {
      const d = shResult(`git -C "${cwd}" branch -D ${b}`)
      if (d.ok) did.push(`deleted ${b}`)
    }
  }

  return { ok: true, sourceDir: cwd, did }
}

export function formatRescuePlan(r) {
  if (!r.ok) {
    let out = `repo-doctor rescue: ${r.error}`
    if (r.diag && !r.fork) out += '\n(Falling back to plain reset would also work but loses the 3-way merge.)'
    return out
  }
  const lines = []
  const short = (h) => h ? h.slice(0, 7) : '?'
  const fmtTime = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '?'

  lines.push(`== Rescue plan (DRY RUN — no action taken) ==`)
  lines.push(`Project: ${r.diag.project}`)
  lines.push(`Source repo: ${r.diag.sourceDir}`)
  lines.push('')

  lines.push(`== Content-fork point ==`)
  lines.push(`Local: ${short(r.fork.local.hash)} — "${r.fork.local.subject}"`)
  lines.push(`  by ${r.fork.local.email} at ${fmtTime(r.fork.local.ts)}`)
  lines.push(`Origin: ${short(r.fork.origin.hash)} — "${r.fork.origin.subject}"`)
  lines.push(`  by ${r.fork.origin.email} at ${fmtTime(r.fork.origin.ts)}`)
  if (r.fork.matchType === 'tree') {
    lines.push(`Matched on full tree hash: ${r.fork.local.tree.slice(0, 12)}…  (every file identical)`)
  } else {
    lines.push(`Matched on paper-scope signature  (paper files identical; other files may differ)`)
  }
  lines.push('')

  lines.push(`== Files that would be touched ==`)
  lines.push(`  Your edits since fork (working-copy vs ${short(r.fork.local.hash)}): ${r.summary.yoursChanged}`)
  lines.push(`  Their edits since fork (${short(r.fork.origin.hash)} vs ${short(r.diag.upstream.hash)}): ${r.summary.theirsChanged}`)
  lines.push(`  Files both sides touched (potential conflicts): ${r.summary.bothTouched}`)
  lines.push('')

  lines.push(`== Dry-run 3-way merge result ==`)
  if (r.cleanMerge) {
    lines.push(`  Clean merge: result tree ${r.mergeResultTree.slice(0,12)}…`)
    lines.push(`  No file requires manual conflict resolution.`)
  } else if (r.mergeResultTree) {
    lines.push(`  Merged with ${r.conflictedFiles.length} conflicted file(s):`)
    for (const f of r.conflictedFiles.slice(0, 20)) lines.push(`    ${f}`)
    if (r.conflictedFiles.length > 20) lines.push(`    … and ${r.conflictedFiles.length - 20} more`)
    lines.push(`  Result tree (with conflict markers embedded): ${r.mergeResultTree.slice(0,12)}…`)
  } else {
    lines.push(`  Merge could not produce a result tree.`)
    if (r.mergeMessages) lines.push(`  Messages:\n    ${r.mergeMessages.split('\n').join('\n    ')}`)
  }
  lines.push('')

  lines.push(`== Steps (when you say go) ==`)
  for (const step of r.plan) lines.push(`  ${step}`)
  lines.push('')

  lines.push(`== Safety ==`)
  lines.push(`  • Current branch tip preserved on: ${r.backupBranch}`)
  lines.push(`  • Working tree captured as tree object before any action`)
  lines.push(`  • No action taken in this run — pass --apply to actually run the steps.`)
  return lines.join('\n')
}

export function formatRescueResult(r) {
  if (!r.ok) {
    let out = `repo-doctor --apply: ${r.error}`
    if (r.completed?.length) {
      out += '\nCompleted before failure:'
      for (const c of r.completed) out += `\n  ✓ ${c.label}`
    }
    if (r.backupBranch) out += `\nBackup branch: ${r.backupBranch}`
    return out
  }
  const lines = []
  lines.push(`== Rescue applied ==`)
  lines.push(`Source repo: ${r.sourceDir}`)
  lines.push(`Backup of old tip: ${r.backupBranch}`)
  lines.push(`Branch: ${r.branch} (master untouched; merge sits in index with MERGE_HEAD = origin)`)
  lines.push(`Fork point grafted: local ${r.fork.local.hash.slice(0,7)} ↔ origin ${r.fork.origin.hash.slice(0,7)}`)
  lines.push('')
  lines.push(`Steps run:`)
  for (const c of r.completed) lines.push(`  ✓ ${c.label}`)
  lines.push('')
  if (r.conflictedFiles?.length) {
    lines.push(`Conflicts in ${r.conflictedFiles.length} file(s) — resolve in editor:`)
    for (const f of r.conflictedFiles) lines.push(`  ${f}`)
  } else if (r.inMerge) {
    lines.push(`Merge in progress, no conflicts surfaced. Run \`git status\` in source dir to verify.`)
  } else {
    lines.push(`No conflicts surfaced and not in merge state — check repo manually.`)
  }
  lines.push('')
  lines.push(`When done resolving:`)
  lines.push(`  git -C "${r.sourceDir}" add <resolved files>`)
  lines.push(`  git -C "${r.sourceDir}" commit -m "<your message>"`)
  return lines.join('\n')
}

/**
 * Format a diagnose result as human-readable text for the CLI.
 */
export function formatDiagnose(r) {
  if (!r.ok) return `repo-doctor: ${r.error}`
  const lines = []
  const fmtTime = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '?'
  const short = (h) => h ? h.slice(0, 7) : '?'

  lines.push(`== ${r.project} ==`)
  lines.push(`Source repo: ${r.sourceDir}`)
  lines.push('')

  lines.push(`== Current branch ==`)
  lines.push(`Branch: ${r.branch}`)
  lines.push(`HEAD: ${short(r.head.hash)} — "${r.head.subject}"`)
  lines.push(`  by ${r.head.email} at ${fmtTime(r.head.ts)}`)
  if (r.head.isShadow) lines.push(`  ⚠ HEAD is a tlda-generated snapshot, not your work`)
  lines.push('')

  lines.push(`== Remotes ==`)
  for (const [n, url] of Object.entries(r.remotes)) {
    lines.push(`  ${n}: ${url}`)
  }
  lines.push('')

  if (r.upstream) {
    lines.push(`== Upstream (${r.upstream.ref}) ==`)
    lines.push(`  ${short(r.upstream.hash)} — "${r.upstream.subject}"`)
    lines.push(`  by ${r.upstream.email} at ${fmtTime(r.upstream.ts)}`)
    if (r.counts.unrelated) {
      lines.push(`  ⚠ No common ancestor with this branch — unrelated histories`)
    } else {
      lines.push(`  Divergence: ${r.counts.total} commits ahead`)
    }
    lines.push('')
  }

  lines.push(`== Branch history vs upstream ==`)
  lines.push(`  ${r.counts.total} commits on this branch since divergence`)
  lines.push(`    ${r.counts.shadow} tlda@local "Build at …" snapshots`)
  lines.push(`    ${r.counts.real} other commits`)
  if (r.lastReal) {
    lines.push(`  Last non-tlda commit on branch:`)
    lines.push(`    ${short(r.lastReal.hash)} — "${r.lastReal.subject}"`)
    lines.push(`    by ${r.lastReal.email} at ${fmtTime(r.lastReal.ts)}`)
  } else {
    lines.push(`  No non-tlda commits found in last 5000 — branch is pure shadow noise`)
  }
  lines.push('')

  lines.push(`== Working tree ==`)
  lines.push(`  Modified: ${r.workingTree.modified}   Staged: ${r.workingTree.staged}   Untracked: ${r.workingTree.untracked}   Conflicted: ${r.workingTree.conflicted}`)
  if (r.workingTree.leftoverDirs.length) {
    lines.push(`  Backup/leftover dirs: ${r.workingTree.leftoverDirs.join(', ')}`)
  }
  lines.push('')

  lines.push(`== Shadow integration ==`)
  lines.push(`  tlda-shadow remote: ${r.remotes['tlda-shadow'] ? 'present' : 'absent'}`)
  lines.push(`  shadow/* tags in repo: ${r.shadow.tagCount}`)
  if (r.shadow.latestTag) lines.push(`  Latest tag: ${r.shadow.latestTag}`)
  lines.push(`  refs/tlda/shadow/HEAD: ${r.shadow.tldaShadowHead ? short(r.shadow.tldaShadowHead) : '(not set)'}`)
  lines.push('')

  lines.push(`== Diagnosis ==`)
  if (r.issues.length === 0) {
    lines.push(`  ✓ Repo looks healthy.`)
  } else {
    for (const issue of r.issues) lines.push(`  ⚠ ${issue}`)
    lines.push('')
    lines.push(`Rescue plan (not yet implemented — diagnose-only for now):`)
    lines.push(`  1. Move working tree to a timestamped backup dir`)
    lines.push(`  2. Reset branch to ${r.upstream?.ref || 'upstream'}`)
    lines.push(`  3. Cherry-pick the ${r.counts.real} real commit(s) on top, if any`)
    lines.push(`  4. Re-init shadow from the cleaned project repo via the filter path`)
    lines.push(`  5. Restore working tree from backup`)
  }
  return lines.join('\n')
}
