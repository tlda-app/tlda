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
import { readdirSync, statSync } from 'node:fs'

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
// Adapter: OpenAI Codex CLI   — STUB for oai (fleet:a7f28763) to complete in place.
// ---------------------------------------------------------------------------
// Path scheme (confirmed): ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
// PRIMARY (open-fd) already works via the shared resolver + isTranscriptPath below.
// oai: refine findByLaunchWindow if the generic newest-after-ts isn't precise enough
// (e.g. cross-check session_meta.id against the launch, per K.40).
const codexAdapter = {
  label: 'codex',
  isTranscriptPath(p) {
    return p.includes('/.codex/sessions/') && p.includes('/rollout-') && p.endsWith('.jsonl')
  },
  findByLaunchWindow({ agent, launchTs }) {
    const root = join(HOME, '.codex', 'sessions')
    return newestUnder([root], (p) => codexAdapter.isTranscriptPath(p), launchTs)
    // TODO(oai): if needed, cross-check the rollout's session_meta.id; see K.40.
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
  const open = await findOpenTranscriptFd(pid, adapter.isTranscriptPath)
  if (open) return open // PRIMARY (K.39)
  return adapter.findByLaunchWindow({ agent, launchTs }) // FALLBACK
}

export { claudeAdapter, codexAdapter, findOpenTranscriptFd }
