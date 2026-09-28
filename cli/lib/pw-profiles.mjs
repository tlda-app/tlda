/**
 * Shared browser-profile directory knowledge for the `pw` verbs.
 *
 * One allowlist, three consumers: the cold reaper (`pw-reap-cold.mjs`;
 * candidacy for SIGTERM), the post-reap cache prune (same file; fires on the
 * reaped event), and the orphan sweep (`tlda-dev pw gc-profiles`; fires on a
 * clock). The allowlist lives here so a new profile scheme moves every
 * consumer at once — the failure this exists to prevent is a reaper (or
 * sweep) that stops covering a scheme while reporting healthy refusals.
 *
 * Classification, in order:
 *   pool      `ud-shared*` anywhere — pool warmth; lifecycle belongs to the
 *             leases path. Recognized and refused, never touched.
 *   session   any other `ud-*` dir — playwright-cli isolated/manual session
 *             profiles (`ud-<session>-chrome*`). Recognized and refused with
 *             a named reason (they are owned by the session lifecycle, not by
 *             the reaper); they must never fall into silent `unknown`.
 *   voice     `.chrome-debug` — the voice lane's debug Chrome. Recognized
 *             and refused; never a reap candidate.
 *   protected browser homes outside candidacy (ms-playwright/daemon leftovers
 *             that match no scheme, Skip's Chrome home). Refused, never
 *             touched. Belt over braces: no candidate pattern reaches them.
 *   candidate per-agent MCP temps (`playwright_chromiumdev_profile-*`).
 *             The only verdict any verb acts on.
 *   unknown   everything else. Refused silently at the row level (a tmp scan
 *             meets hundreds of unrelated entries) but counted in the report.
 */

import fs from 'node:fs'
import path from 'node:path'

export const MCP_TEMP_TOKEN = 'playwright_chromiumdev_profile'
export const POOL_TOKEN = 'ud-shared'
export const CACHE_DIR_NAMES = ['Cache', 'Code Cache']
export const ORPHAN_MIN_AGE_MS = 30 * 60 * 1000

export function classifyProfileDir(dir) {
  const p = String(dir)
  const base = path.basename(p)
  if (base.includes(POOL_TOKEN)) {
    return { verdict: 'pool', reason: 'pool lifecycle belongs to leases; this reaper is MCP-only' }
  }
  // Any `ud-` prefix: playwright-cli session profiles (`ud-<session>-chrome*`),
  // matched the way the voice reset handler's own `daemon/*/ud-*` glob sees
  // them. Broad is safe here — session is a named refusal, never candidacy.
  if (base.startsWith('ud-')) {
    return { verdict: 'session', reason: 'playwright-cli session profile; lifecycle belongs to the leases path' }
  }
  if (base === '.chrome-debug') {
    return { verdict: 'voice', reason: 'voice-lane debug Chrome; owned by the voice lane, never a reap candidate' }
  }
  if (p.includes(`${path.sep}ms-playwright${path.sep}daemon${path.sep}`)
    || /Application Support\/Google\/Chrome(\/|$)/.test(p)) {
    return { verdict: 'protected', reason: 'browser home outside candidacy; never touched' }
  }
  if (base.includes(MCP_TEMP_TOKEN)) {
    return { verdict: 'candidate', reason: 'per-agent MCP temp profile' }
  }
  return { verdict: 'unknown', reason: 'not a recognized fleet profile scheme' }
}

export function userDataDirOf(command) {
  const m = String(command).match(/user-data-dir=([^\s]+)/)
  return m ? m[1] : null
}

/**
 * Reaper-facing classification of a browser main's command line. Return
 * contract is the landed one (`mcp-temp`, `pool:<suffix>`, `other`,
 * `unknown`) plus `session:<suffix>` for recognized non-pool session
 * profiles and `voice` for the voice-lane debug profile — still refused,
 * but named rather than silent.
 */
export function profileOf(command) {
  const udd = userDataDirOf(command)
  if (!udd) return 'unknown'
  if (udd.includes(POOL_TOKEN)) return 'pool:' + (udd.match(/ud-(shared[^/\s]*)/)?.[1] || '?')
  const base = path.basename(udd)
  if (base.startsWith('ud-')) return 'session:' + (udd.match(/ud-([^/\s]+)/)?.[1] || '?')
  if (base === '.chrome-debug') return 'voice'
  if (udd.includes(MCP_TEMP_TOKEN)) return 'mcp-temp'
  return 'other'
}

// Logical sizes (st_size), not blocks: deterministic across runs and
// filesystems, which is what the tests pin. It diverges from `du` in both
// directions — over on sparse cache files (observed ~1.5x on cache-heavy
// profiles), under on small-file trees via block rounding — so `df`/`du`
// are the authoritative instrument for disk impact; this is the inventory
// one.
export function duBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const parent = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(parent, e.name)
      try {
        if (e.isDirectory() && !e.isSymbolicLink()) stack.push(full)
        else if (e.isFile()) total += fs.statSync(full).size
      } catch {
        // Unreadable entry: skip. The total is then a floor, which is the
        // honest direction for a reclamation report.
      }
    }
  }
  return total
}

function profileSubdirs(userDataDir) {
  const subs = ['Default']
  let children
  try {
    children = fs.readdirSync(userDataDir, { withFileTypes: true })
  } catch {
    return subs
  }
  for (const c of children) {
    if (c.isDirectory() && /^Profile \d+$/.test(c.name)) subs.push(c.name)
  }
  return subs
}

/**
 * Remove regenerable HTTP/code caches from a profile dir. Only `Cache` and
 * `Code Cache` under each Chromium profile subdir — cookies, storage, and
 * preferences are never touched. Returns bytes reclaimed + paths removed.
 */
export function pruneProfileCaches(userDataDir, { dryRun = false } = {}) {
  const removed = []
  let prunedBytes = 0
  for (const sub of profileSubdirs(userDataDir)) {
    for (const cache of CACHE_DIR_NAMES) {
      const p = path.join(userDataDir, sub, cache)
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      prunedBytes += duBytes(p)
      removed.push(p)
      if (!dryRun) fs.rmSync(p, { recursive: true, force: true })
    }
  }
  return { prunedBytes, removed }
}

function liveProfileDirs(psText) {
  const out = new Set()
  for (const line of String(psText).split('\n')) {
    const udd = userDataDirOf(line)
    if (udd) out.add(udd)
  }
  return out
}

function referencedInPs(full, psText, live) {
  if (live.has(full)) return true
  try {
    if (live.has(fs.realpathSync(full))) return true
  } catch {
    // Unresolvable path: fall through to the basename check.
  }
  // Basename is the full `playwright_chromiumdev_profile-XXXXXX`, random
  // suffix included — appearing anywhere in ps means a live process names
  // this profile. Holding on a substring is the conservative direction.
  return psText.includes(path.basename(full))
}

/**
 * One-shot orphan sweep over tmp roots (one level, real dirs only, never
 * following symlinks). A candidate is collected only when all three hold:
 * old enough (not mid-launch), unreferenced by any live command line, and
 * removable. Every recognized non-candidate (pool, session, voice,
 * protected) is refused with its reason printed — a named refusal reads as
 * a decision where an absent case reads as an oversight. Unrecognized
 * entries are ignored and counted. Pure except for fs + the injected ps
 * text.
 */
export function collectOrphanProfiles({
  roots,
  psText,
  now = Date.now(),
  minAgeMs = ORPHAN_MIN_AGE_MS,
  dryRun = false,
} = {}) {
  const live = liveProfileDirs(psText)
  const decisions = []
  let scanned = 0
  let ignored = 0
  const seenRoots = new Set()
  const shownRoots = []
  for (const root of roots || []) {
    let real
    try {
      real = fs.realpathSync(root)
    } catch {
      continue
    }
    if (seenRoots.has(real)) continue
    seenRoots.add(real)
    shownRoots.push(root)
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      // No dotfile skip: `.chrome-debug` is a dotdir and a recognized
      // scheme. Unrecognized dotdirs fall into `unknown` → ignored+counted,
      // same as any other non-profile entry.
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      const full = path.join(root, e.name)
      const cls = classifyProfileDir(full)
      if (cls.verdict === 'unknown') {
        ignored++
        continue
      }
      scanned++
      const base = { path: full, profile: cls.verdict }
      if (cls.verdict !== 'candidate') {
        const guard = cls.verdict === 'pool' ? 'scope' : cls.verdict
        decisions.push({ ...base, verdict: 'refuse', guard, reason: cls.reason })
        continue
      }
      if (referencedInPs(full, psText, live)) {
        decisions.push({ ...base, verdict: 'held', guard: 'live', reason: 'a live command line references this profile' })
        continue
      }
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(full).mtimeMs
      } catch (err) {
        decisions.push({ ...base, verdict: 'error', reason: `cannot stat: ${err.message}` })
        continue
      }
      if (now - mtimeMs < minAgeMs) {
        decisions.push({ ...base, verdict: 'held', guard: 'age', reason: `younger than ${Math.round(minAgeMs / 60000)}min; may be mid-launch` })
        continue
      }
      const bytes = duBytes(full)
      if (!dryRun) {
        try {
          fs.rmSync(full, { recursive: true, force: true })
        } catch (err) {
          decisions.push({ ...base, verdict: 'error', reason: `cannot remove: ${err.message}` })
          continue
        }
        decisions.push({ ...base, verdict: 'collected', bytes })
      } else {
        decisions.push({ ...base, verdict: 'would-collect', bytes })
      }
    }
  }
  return { decisions, scanned, ignored, dryRun, roots: shownRoots }
}

export function defaultGcRoots() {
  const roots = []
  if (process.env.TMPDIR) roots.push(process.env.TMPDIR)
  roots.push('/tmp', '/private/tmp')
  const out = []
  const seen = new Set()
  for (const r of roots) {
    try {
      const real = fs.realpathSync(r)
      if (!seen.has(real)) { seen.add(real); out.push(r) }
    } catch {
      // Missing root: not an error, just unscanned.
    }
  }
  return out
}

export function formatGcReport(result) {
  const lines = []
  lines.push(`roots: ${result.roots.join(', ') || '(none readable)'}${result.dryRun ? ' --dry-run: nothing removed' : ''}`)
  lines.push(`scanned ${result.scanned} recognized profile(s), ignored ${result.ignored} unrecognized entries`)
  let reclaimed = 0
  for (const d of result.decisions) {
    const mb = d.bytes != null ? ` ${(d.bytes / 1048576).toFixed(1)}MB` : ''
    if (d.verdict === 'collected') { reclaimed += d.bytes || 0; lines.push(`  COLLECTED ${d.path}${mb}`) }
    else if (d.verdict === 'would-collect') lines.push(`  WOULD-COLLECT ${d.path}${mb}`)
    else if (d.verdict === 'refuse') lines.push(`  REFUSE(${d.guard}) ${d.path}: ${d.reason}`)
    else if (d.verdict === 'held') lines.push(`  HELD(${d.guard}) ${d.path}: ${d.reason}`)
    else lines.push(`  ERROR ${d.path}: ${d.reason}`)
  }
  if (!result.decisions.length) lines.push('  no recognized profiles found')
  if (!result.dryRun) lines.push(`reclaimed: ${(reclaimed / 1048576).toFixed(1)}MB`)
  return lines.join('\n')
}
