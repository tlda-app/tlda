/**
 * Per-environment runtime roots.
 *
 * `daemon.yaml` declares, per environment, where that environment's local
 * runtime lives: `environments.<env>.runtimeRoot`. Absent means "whatever tree
 * this process was loaded from" (the historical `repoRoot()` module-location
 * behavior) — which is what non-developer boxes keep running, untouched by any
 * testing override.
 *
 * The testing developer daemon declares its managed runtime checkout; the
 * deploy hook owns resetting that checkout, and `local-runtime-only` updates
 * only testing's managed runtime. Launcher, MCP server, and session hooks
 * always derive from the daemon's own runtime root and never select a ref.
 */
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

/** Grep token the deploy hook polls the daemon log for after a restart. */
export const RUNTIME_STAMP_TOKEN = 'tlda-runtime'

/**
 * Resolve the runtime root for one validated environment entry.
 * Pure: takes the validated `environments.values` map, not the config file.
 */
export function resolveRuntimeRootForEnv(values, envName, fallbackRoot) {
  const raw = values?.[envName]
  if (!raw || typeof raw !== 'object') {
    throw new Error(`tlda config: no environment named "${envName}" in daemon.yaml environments — known: ${Object.keys(values || {}).join(', ') || '(none)'}`)
  }
  const declared = typeof raw.runtimeRoot === 'string' ? raw.runtimeRoot.trim() : ''
  if (declared) return { runtimeRoot: declared, declared: true }
  return { runtimeRoot: fallbackRoot, declared: false }
}

/** Compare two roots by real path; unresolvable paths compare lexically. */
export function runtimeRootsMatch(a, b) {
  if (a === b) return true
  const norm = (p) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  try {
    return norm(a) === norm(b)
  } catch {
    return false
  }
}

export function isAbsoluteRoot(p) {
  return typeof p === 'string' && !!p.trim() && isAbsolute(p)
}

/** One-line boot stamp the daemon logs and the deploy hook polls for. */
export function runtimeStampLine({ sha, root, env }) {
  return `${RUNTIME_STAMP_TOKEN} sha=${sha} root=${root} env=${env}`
}

/** Best-effort HEAD sha of the checkout at `root`; 'unknown' when not a git tree. */
export function readCheckoutSha(root) {
  try {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Fail-closed startup check, pure for testability.
 *
 * When the environment declares a runtimeRoot and this process was loaded from
 * anywhere else, that is the hidden-second-runtime bug: refuse with a message
 * naming both paths and the fix. Undeclared environments and unreadable
 * configs keep the standing module-location behavior.
 */
export function checkRuntimeRoot({ declared, configuredRoot, actualRoot }) {
  if (!declared) return { ok: true }
  if (runtimeRootsMatch(configuredRoot, actualRoot)) return { ok: true }
  return {
    ok: false,
    message: [
      `refusing to start: this process was loaded from ${actualRoot}`,
      `but daemon.yaml declares runtimeRoot ${configuredRoot} for this environment.`,
      `Running from an undeclared tree splits the runtime authority (daemon in one tree, agents in another).`,
      `Fix: reset ${configuredRoot} to the intended revision and restart from there — never point launchd, MCP, launcher, or hooks at a second tree.`,
    ].join(' '),
  }
}
