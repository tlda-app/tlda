/**
 * Cold MCP-browser reaper (`tlda-dev pw reap-cold`).
 *
 * One-shot, stateful across runs: each invocation takes one process snapshot,
 * updates per-tree CPU history in a state file, and SIGTERMs the browser main
 * of any MCP-browser tree whose cold run spans its window. No timer, no
 * scheduling — ops runs it (manually or from cron); history accumulates
 * across invocations, so the first run only records baselines and reaps
 * nothing. `--dry-run` still records history (so repeated dry runs build
 * the same cold runs a live schedule would); it only withholds the signal.
 *
 * Cold = whole-tree CPU delta below max(1s, 2% of elapsed) across
 * CONSECUTIVE samples spanning the window: 60 minutes when the owner is
 * alive, 15 when hibernating/dead/unknown. Single-sample cold never trips —
 * the watch showed single cold samples flanked by warm ones, which is what
 * consecutive-runs exist to reject.
 *
 * SAFETY INVARIANT — the reaper kills browsers, never servers. Killing a
 * browser main is invisible (the MCP server relaunches it on the next tool
 * call); killing the server wedges its client. Identity is re-verified on
 * the full command line immediately before the signal, and only pids that
 * re-verify as browser mains are signalled.
 *
 * CANDIDACY is an opt-in allowlist on user-data-dir, shared with the
 * orphan sweep (`pw-profiles.mjs`, single home for the scheme table): only
 * `mcp-temp` (per-agent MCP browsers) is ever reaped. Pool profiles are
 * recognized and explicitly refused — the pool has lease machinery with
 * idle policies and holds multiple agents' tabs plus warm classroom state,
 * so its lifecycle belongs to that path. Other playwright-cli session
 * profiles and the voice-lane debug profile are likewise recognized and
 * refused by name. Anything else (unknown profile, no user-data-dir) is
 * refused by the allowlist. Skip's browser is exempt by this construction:
 * it is not on the list, so no code path can name it, regardless of
 * whether it ever runs on a fleet box.
 *
 * POST-REAP PRUNE: a reaped profile's `Cache` / `Code Cache` are disposable
 * (~1.5GB against ~60MB of real state at the heavy end) and regenerate, so
 * after the confirmed-exit recheck proves the browser is gone, the prune
 * wipes them — never before (a dying browser recreates cache mid-shutdown)
 * and never when the pid survives (still-alive means a live browser holds
 * the profile).
 *
 * NOT implemented (stated, not silently absent): the no-in-flight-call
 * guard exists as a requirement, not as code — the harness signal for it
 * does not exist yet. Consequence: this reaper covers the cold guard only
 * and cannot support deleting the pw lock, whose job overlaps precisely
 * with the protection that does not exist yet.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { profileOf, userDataDirOf, pruneProfileCaches } from './pw-profiles.mjs'

// Single home for the scheme table is pw-profiles.mjs; re-exported so the
// landed import surface keeps working.
export { profileOf }

export const DEFAULT_STATE_FILE = path.join(homedir(), '.config', 'tlda', 'pw-reap-cold-state.json')
export const ALIVE_WINDOW_MS = 60 * 60 * 1000
export const IDLE_WINDOW_MS = 15 * 60 * 1000
export const STATE_VERSION = 1
const MIN_PS_LINES = 5
const KILL_RECHECK_MS = 10 * 1000

export function parseCpuTime(t) {
  // [[dd-]hh:]mm:ss[.frac]
  const parts = String(t).split(/[-:]/).map(Number)
  let s = 0
  let mult = 1
  while (parts.length) { s += parts.pop() * mult; mult *= 60 }
  return s
}

export function parsePsTable(text) {
  const procs = new Map()
  for (const line of String(text).split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const [, pid, ppid, rss, time, command] = m
    procs.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), rssKB: Number(rss), cpu: parseCpuTime(time), command })
  }
  // The instrument failed, the box is not empty: refuse rather than report
  // a small table as a quiet box.
  if (procs.size < MIN_PS_LINES) throw new Error(`ps table too thin (${procs.size} procs): refusing to evaluate`)
  return procs
}

export function isBrowserMain(p) {
  return /MacOS\/Google Chrome for Testing/.test(p.command)
    && !/Helpers/.test(p.command)
    && !/cli\.js/.test(p.command)
    && !/crashpad/.test(p.command)
    && !/playwright\/mcp/.test(p.command)
}

export function treePids(procs, root) {
  const kids = new Map()
  for (const p of procs.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, [])
    kids.get(p.ppid).push(p.pid)
  }
  const out = []
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()
    out.push(pid)
    for (const k of kids.get(pid) || []) stack.push(k)
  }
  return out
}

export function treeStats(procs, root) {
  const members = treePids(procs, root).map((pid) => procs.get(pid)).filter(Boolean)
  return {
    pids: members.map((p) => p.pid),
    rssKB: members.reduce((s, p) => s + p.rssKB, 0),
    cpu: members.reduce((s, p) => s + p.cpu, 0),
  }
}

export function ownerOf(procs, pid) {
  // Walk up past the MCP server to the tmux seat (`fleet-<name>-<n>`).
  // Server env carries no fleet vars, so the seat name is the path.
  let cur = procs.get(pid)
  let depth = 0
  while (cur && depth < 14) {
    const m = cur.command.match(/fleet-([A-Za-z0-9][A-Za-z0-9_-]*?)(?:-\d+)?(?:\s|$)/)
    if (m) return m[1].replace(/-\d+$/, '')
    if (cur.ppid <= 1 || !procs.get(cur.ppid)) break
    cur = procs.get(cur.ppid)
    depth++
  }
  return 'unknown'
}

export function coldThresholdS(elapsedS) {
  return Math.max(1, elapsedS * 0.02)
}

export function windowFor(ownerAwake, { aliveMs = ALIVE_WINDOW_MS, idleMs = IDLE_WINDOW_MS } = {}) {
  // Unknown liveness takes the long window: failing closed protects a
  // thinking agent we failed to attribute.
  return ownerAwake === true ? aliveMs : ownerAwake === false ? idleMs : aliveMs
}

/**
 * Comm-based census. `comm` carries the binary path, never arguments — so a
 * node MCP server (comm `.../bin/node`) cannot match a browser census the
 * way it does under a command-line substring, where `--executable-path`
 * makes every idle server read as a browser. Count here, identify on the
 * full command line.
 */
export function commCensus(psCommRssText) {
  let browsers = 0
  let browserRssKB = 0
  let node = 0
  let nodeRssKB = 0
  for (const line of String(psCommRssText).split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!m) continue
    const rss = Number(m[1])
    const comm = m[2]
    if (comm.includes('Google Chrome for Testing')) { browsers++; browserRssKB += rss }
    else if (/(^|\/)node$/.test(comm)) { node++; nodeRssKB += rss }
  }
  // `node` is every node process on the box, not MCP servers specifically —
  // comm cannot see arguments, so it cannot distinguish them. Labelled as
  // what it is rather than as the subset we care about.
  return { browsers: { n: browsers, rssMB: Math.round(browserRssKB / 1024) }, node: { n: node, rssMB: Math.round(nodeRssKB / 1024) } }
}

function treeKey(profile, owner, pid) {
  return `${profile}|${owner}|${pid}`
}

export function loadState(stateFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (raw?.version === STATE_VERSION && raw?.trees && typeof raw.trees === 'object') return raw
  } catch {
    // Missing, unreadable, or wrong version: start over. History loss is
    // conservative (cold runs restart), never permissive.
  }
  return { version: STATE_VERSION, trees: {} }
}

export function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`)
}

export function awakeSet({ execFileSync: exec = execFileSync, tldaBin = 'tlda' } = {}) {
  // Roster lists awake first; --limit 100 covers the awake set with margin.
  // The header count is the check: mismatch means refetch full, never guess.
  const fetch = (limit) => exec(tldaBin, ['agent', 'list', '--limit', String(limit)], { encoding: 'utf8', timeout: 60000 })
  let out = fetch(100)
  const header = out.match(/(\d+) awake/)
  let awake = out.split('\n').filter((l) => /^  awake\s/.test(l)).map((l) => l.trim().split(/\s+/)[1])
  if (!header || awake.length < Number(header[1])) {
    out = fetch(10000)
    awake = out.split('\n').filter((l) => /^  awake\s/.test(l)).map((l) => l.trim().split(/\s+/)[1])
  }
  return new Set(awake)
}

/**
 * Evaluate one tree against its stored record. Returns { verdict, record }
 * where verdict is baseline|warm|cold|trip and record is the updated record
 * to persist. Pure: no ps, no roster, no kill.
 */
export function evaluateTree({ record, now, treeCpu, elapsedS, windowMs }) {
  if (!record || typeof record.lastCpu !== 'number') {
    return { verdict: 'baseline', record: { lastCpu: treeCpu, lastSeen: now, coldSince: null, coldStreak: 0 } }
  }
  const delta = Math.max(0, treeCpu - record.lastCpu)
  const cold = delta < coldThresholdS(elapsedS)
  if (!cold) {
    return { verdict: 'warm', detail: { cpuDeltaS: delta }, record: { lastCpu: treeCpu, lastSeen: now, coldSince: null, coldStreak: 0 } }
  }
  const coldSince = record.coldSince ?? now
  const coldStreak = (record.coldStreak || 0) + 1
  const next = { lastCpu: treeCpu, lastSeen: now, coldSince, coldStreak }
  if (now - coldSince >= windowMs) return { verdict: 'trip', detail: { cpuDeltaS: delta, coldSince, coldStreak }, record: next }
  return { verdict: 'cold', detail: { cpuDeltaS: delta, coldSince, coldStreak }, record: next }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runReapCold({
  stateFile = DEFAULT_STATE_FILE,
  dryRun = false,
  windowMinutes = null,
  now = Date.now(),
  execFileSync: exec = execFileSync,
  kill = (pid) => process.kill(pid, 'SIGTERM'),
  recheckMs = KILL_RECHECK_MS,
} = {}) {
  const windows = windowMinutes != null
    ? { aliveMs: windowMinutes * 60 * 1000, idleMs: windowMinutes * 60 * 1000, override: true }
    : { aliveMs: ALIVE_WINDOW_MS, idleMs: IDLE_WINDOW_MS, override: false }
  const before = commCensus(exec('ps', ['-Ao', 'rss,comm'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  const procs = parsePsTable(exec('ps', ['-Ao', 'pid,ppid,rss,time,command'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  const awake = awakeSet({ execFileSync: exec })
  const state = loadState(stateFile)
  const nextTrees = {}
  const decisions = []

  for (const m of [...procs.values()].filter(isBrowserMain)) {
    const profile = profileOf(m.command)
    const owner = ownerOf(procs, m.pid)
    const stats = treeStats(procs, m.pid)
    const base = { pid: m.pid, profile, owner, rssMB: Math.round(stats.rssKB / 1024) }
    if (profile !== 'mcp-temp') {
      // Pool/session/voice: recognized, out of scope. Everything else: not
      // on the allowlist. All refuse; the guard names which.
      const guard = profile.startsWith('pool:') ? 'scope'
        : profile.startsWith('session:') ? 'session'
        : profile === 'voice' ? 'voice' : 'profile'
      const reason = guard === 'scope' ? 'pool lifecycle belongs to leases; this reaper is MCP-only'
        : guard === 'session' ? 'playwright-cli session profile; lifecycle belongs to the leases path'
        : guard === 'voice' ? 'voice-lane debug Chrome; owned by the voice lane, never a reap candidate'
        : 'not on the candidacy allowlist'
      decisions.push({ ...base, verdict: 'refuse', guard, reason })
      continue
    }
    const ownerAwake = owner === 'unknown' ? null : awake.has(owner)
    const key = treeKey(profile, owner, m.pid)
    let record = state.trees[key]
    // Pid reuse / identity drift: a record only applies to the same tree.
    if (record && (record.pid !== m.pid || record.profile !== profile)) record = null
    const elapsedS = record ? Math.max(1, (now - record.lastSeen) / 1000) : 0
    const windowMs = windowFor(ownerAwake, windows)
    const { verdict, detail, record: updated } = evaluateTree({ record, now, treeCpu: stats.cpu, elapsedS, windowMs })
    nextTrees[key] = { ...updated, pid: m.pid, profile, owner, ownerAwake }
    if (verdict === 'trip' && !dryRun) {
      // Re-verify identity on a fresh snapshot immediately before the
      // irreversible step; the tree may have relaunched mid-run.
      const fresh = parsePsTable(exec('ps', ['-Ao', 'pid,ppid,rss,time,command'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
      const target = fresh.get(m.pid)
      if (!target || !isBrowserMain(target) || profileOf(target.command) !== 'mcp-temp') {
        decisions.push({ ...base, ownerAwake, verdict: 'refuse', guard: 'identity', reason: 'target changed identity before kill' })
        continue
      }
      kill(m.pid)
      await sleep(recheckMs)
      let alive = true
      try {
        const check = parsePsTable(exec('ps', ['-Ao', 'pid,ppid,rss,time,command'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
        alive = check.has(m.pid)
      } catch {
        alive = false
      }
      delete nextTrees[key]
      if (!alive) {
        // Confirmed exit: prune the reaped profile's regenerable caches.
        // The dir comes from the re-verified target's command line — the
        // process actually signaled — and a prune failure must not fail the
        // reap, so it is recorded, not thrown.
        const udd = userDataDirOf(target.command)
        let prune = { prunedBytes: 0, pruned: [] }
        if (udd) {
          try {
            const r = pruneProfileCaches(udd)
            prune = { prunedBytes: r.prunedBytes, pruned: r.removed }
          } catch (err) {
            prune = { prunedBytes: 0, pruned: [], pruneError: err.message }
          }
        }
        decisions.push({ ...base, ownerAwake, verdict: 'reaped', detail: { ...detail, signal: 'SIGTERM', ...prune } })
      } else {
        decisions.push({ ...base, ownerAwake, verdict: 'still-alive', detail: { ...detail, signal: 'SIGTERM' } })
      }
    } else if (verdict === 'trip') {
      decisions.push({ ...base, ownerAwake, verdict: 'would-reap', detail })
    } else {
      decisions.push({ ...base, ownerAwake, verdict, ...(detail ? { detail } : {}) })
    }
  }

  // nextTrees holds exactly the trees present this run (minus reaped
  // ones), so assigning prunes records for exited trees.
  state.trees = nextTrees
  saveState(stateFile, state)

  let after = before
  if (decisions.some((d) => d.verdict === 'reaped')) {
    after = commCensus(exec('ps', ['-Ao', 'rss,comm'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  }
  return { windows, census: { before, after }, decisions, stateFile, dryRun }
}

export function formatReport(result) {
  const lines = []
  const w = result.windows
  lines.push(`windows: alive ${w.aliveMs / 60000}min / idle ${w.idleMs / 60000}min${w.override ? ' (OVERRIDE)' : ''}${result.dryRun ? ' --dry-run: nothing killed' : ''}`)
  const c = result.census
  lines.push(`census(comm): browsers ${c.before.browsers.n}/${c.before.browsers.rssMB}MB → ${c.after.browsers.n}/${c.after.browsers.rssMB}MB; node ${c.before.node.n}/${c.before.node.rssMB}MB → ${c.after.node.n}/${c.after.node.rssMB}MB`)
  for (const d of result.decisions) {
    const who = `${d.pid} ${d.profile} owner=${d.owner}${d.ownerAwake == null ? '' : d.ownerAwake ? '(awake)' : '(idle)'}`;
    if (d.verdict === 'reaped') lines.push(`  REAPED ${who} ${d.rssMB}MB cold-since=${d.detail.coldSince ? new Date(d.detail.coldSince).toISOString() : '?'} streak=${d.detail.coldStreak}${d.detail.prunedBytes ? ` pruned=${(d.detail.prunedBytes / 1048576).toFixed(1)}MB` : ''}${d.detail.pruneError ? ` prune-error=${d.detail.pruneError}` : ''}`)
    else if (d.verdict === 'would-reap') lines.push(`  WOULD-REAP ${who} ${d.rssMB}MB streak=${d.detail.coldStreak}`)
    else if (d.verdict === 'refuse') lines.push(`  REFUSE(${d.guard}) ${who}: ${d.reason}`)
    else if (d.verdict === 'warm') lines.push(`  warm ${who} ${d.rssMB}MB Δ=${d.detail.cpuDeltaS}s`)
    else if (d.verdict === 'cold') lines.push(`  cold ${who} ${d.rssMB}MB streak=${d.detail.coldStreak}`)
    else if (d.verdict === 'still-alive') lines.push(`  STILL-ALIVE ${who} — SIGTERM delivered, pid persists; no escalation`)
    else lines.push(`  baseline ${who} ${d.rssMB}MB (first sample; no decision)`)
  }
  if (!result.decisions.length) lines.push('  no browser mains found')
  lines.push(`state: ${result.stateFile}`)
  return lines.join('\n')
}


