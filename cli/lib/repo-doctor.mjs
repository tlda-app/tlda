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
