// Vendor-agnostic transcript resolution — spec section K ("Transcript binding").
//
// THE CONTRACT (one signature, every runtime builds to it):
//
//     resolveTranscript({ pid, kind, agent, launchTs }) -> absolute transcript path | null
//
// The fleet id is the anchor (carried in the agent via $FLEET_ID; the daemon's
// process scan gives us the runtime PID + kind). We resolve the *current* transcript
// for that agent two ways, in order:
//
//   1. PRIMARY  — the transcript the runtime PID holds OPEN for writing (PID -> open write-fd).
//                 Confirmed for Codex (oai spike 2026-06-15: `lsof` shows the codex PID
//                 holding rollout-*.jsonl with a write fd for the whole session) and works
//                 for Claude. This is "maintain, don't trust a stored handle" (spec J).
//   2. FALLBACK — newest transcript under the runtime's transcript dir created at/after the
//                 launch timestamp. Used only for the brief window before the file is opened,
//                 or a runtime that append-closes per write.
//
// Each runtime supplies a small ADAPTER: { label, isTranscriptPath(path), findByLaunchWindow({agent, launchTs}) }.
// Internals stay independent — add a runtime by adding an adapter, nothing else changes.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'

const execFileP = promisify(execFile)
const HOME = homedir()

// ---------------------------------------------------------------------------
// Shared PRIMARY resolver: the transcript file `pid` holds open for writing.
// ---------------------------------------------------------------------------
// Parses `lsof -p <pid> -F fan`: records are grouped per fd —
//   f<fd>\n  a<access>\n  n<name>\n   (access ∈ r|w|u; we want w or u = writable)
// Returns the first writable open file whose path the adapter recognizes as a transcript.
// NB: lsof returns the CANONICAL (realpath) path — e.g. macOS /var -> /private/var.
// That's why adapters match with substring/suffix checks, not strict equality. The
// returned path is the real file (authoritative); treat it as such, don't compare it
// against a non-canonical expected path.
async function findOpenTranscriptFd(pid, isTranscriptPath) {
  if (!pid) return null
  let stdout
  try {
    ;({ stdout } = await execFileP('lsof', ['-p', String(pid), '-F', 'fan'], { timeout: 3000 }))
  } catch {
    return null // pid gone, or lsof unavailable -> let the caller fall back
  }
  let access = ''
  for (const line of stdout.split('\n')) {
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'f') access = '' // new fd record
    else if (tag === 'a') access = val
    else if (tag === 'n') {
      const writable = access.includes('w') || access.includes('u')
      if (writable && isTranscriptPath(val)) return val
    }
  }
  return null
}

// Generic newest-file-after-timestamp helper for adapter fallbacks.
function newestUnder(dirs, matches, sinceMs) {
  let best = null
  let bestMtime = sinceMs ? sinceMs - 1 : -Infinity
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (matches(p)) {
        let st
        try { st = statSync(p) } catch { continue }
        if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p }
      }
    }
  }
  for (const d of dirs) walk(d)
  return best
}

function readFilePrefix(path, maxBytes = 128 * 1024) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.toString('utf8', 0, n)
  } catch {
    return ''
  } finally {
    if (fd != null) {
      try { closeSync(fd) } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter: Claude Code
// ---------------------------------------------------------------------------
const claudeAdapter = {
  label: 'claude',
  // ~/.claude/projects/<cwd-hash>/<session-uuid>.jsonl  (filename IS the session id)
  isTranscriptPath(p) {
    return p.includes('/.claude/projects/') && p.endsWith('.jsonl')
  },
  findByLaunchWindow({ agent, launchTs }) {
    // Fallback only. Newest jsonl under the agent's project dir(s) after launch.
    // (The daemon's syncSessionWatchers has the richer cwd-hash logic; this is the
    // adapter-local fallback so the resolver is self-contained.)
    const root = join(HOME, '.claude', 'projects')
    return newestUnder([root], (p) => p.endsWith('.jsonl'), launchTs)
  },
}

// ---------------------------------------------------------------------------
// Adapter: OpenAI Codex CLI
// ---------------------------------------------------------------------------
// Path scheme (confirmed): ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
// PRIMARY (open-fd) already works via the shared resolver + isTranscriptPath below.
// The launch-window fallback must prove ownership from the rollout contents.
// A global "newest rollout" fallback misroutes live agents whenever several
// Codex sessions start close together.
function codexRolloutBelongsToAgent(path, agent) {
  if (!agent) return false
  const text = readFilePrefix(path)
  if (!text) return false

  const ids = [agent.id, agent.fleet_id, agent.fleetId]
    .filter(id => typeof id === 'string' && id.length > 0)
  if (ids.some(id => text.includes(id))) return true

  const name = agent.friendly_name || agent.name
  if (typeof name !== 'string' || !name) return false
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:register\\(name=\\\\?"${quoted}\\\\?"\\)|Your name:\\s*\\\\?"${quoted}\\\\?")`).test(text)
}

function codexRolloutHasOwnerEvidence(path) {
  const text = readFilePrefix(path)
  return /\bRegistered fleet:[a-f0-9]+\b/.test(text) || /\bYour name:\s*\\?"/.test(text)
}

function readFirstJson(path) {
  const text = readFilePrefix(path)
  if (!text) return null
  const firstLine = text.split(/\r?\n/, 1)[0]
  if (!firstLine) return null
  try {
    return JSON.parse(firstLine)
  } catch {
    return null
  }
}

function codexRolloutMatchesLaunch(path, agent, launchTs) {
  if (!agent?.cwd || !launchTs) return false
  const first = readFirstJson(path)
  if (first?.type !== 'session_meta') return false
  const payload = first.payload || {}
  if (payload.cwd !== agent.cwd) return false
  const ts = Date.parse(payload.timestamp || first.timestamp || '')
  if (!Number.isFinite(ts)) return false
  return ts >= launchTs - 5_000 && ts <= launchTs + 60_000
}

const codexAdapter = {
  label: 'codex',
  isTranscriptPath(p) {
    return p.includes('/.codex/sessions/') && p.includes('/rollout-') && p.endsWith('.jsonl')
  },
  findByLaunchWindow({ agent, launchTs }) {
    const root = join(HOME, '.codex', 'sessions')
    const knownIds = []
    if (agent?.session_id) knownIds.push(agent.session_id)
    for (const sid of (agent?.session_ids || [])) {
      if (sid && !knownIds.includes(sid)) knownIds.push(sid)
    }
    const matches = knownIds.length
      ? (p) => knownIds.some(id => p.endsWith(`-${id}.jsonl`))
          && (!codexRolloutHasOwnerEvidence(p) || codexRolloutBelongsToAgent(p, agent))
      : (p) => this.isTranscriptPath(p)
          && (codexRolloutBelongsToAgent(p, agent)
            || (!codexRolloutHasOwnerEvidence(p) && codexRolloutMatchesLaunch(p, agent, launchTs)))
    return newestUnder([root], matches, launchTs)
  },
}

// ---------------------------------------------------------------------------
// Kind dispatch
// ---------------------------------------------------------------------------
// `kind` comes from the daemon's process classification (it already does isClaude /
// isGoose off the pane process tree — extend that to detect 'codex' from `codex` in
// the runtime argv). Default to claude for back-compat.
const ADAPTERS = {
  claude: claudeAdapter,
  codex: codexAdapter,
  // goose: gooseAdapter,  // (future — goose transcripts live in sqlite, not a jsonl file; see lib/goose-activity.mjs)
}

export function adapterForKind(kind) {
  return ADAPTERS[kind] || claudeAdapter
}

// The one signature every runtime builds to.
export async function resolveTranscript({ pid, kind, agent, launchTs }) {
  const adapter = adapterForKind(kind)
  // Codex fallback ownership checks read rollout prefixes under ~/.codex/sessions.
  // That is acceptable as a rare fallback after a live runtime PID exists, but it
  // is unbounded when called for hibernating/stale roster rows. Without a PID
  // there is no live writer to bind, so do not scan the global Codex session tree.
  if (!pid && kind === 'codex') return null
  const open = await findOpenTranscriptFd(pid, adapter.isTranscriptPath)
  if (open) return open // PRIMARY (K.39)
  return adapter.findByLaunchWindow({ agent, launchTs }) // FALLBACK
}

export { claudeAdapter, codexAdapter, codexRolloutBelongsToAgent, codexRolloutHasOwnerEvidence, codexRolloutMatchesLaunch, findOpenTranscriptFd }
