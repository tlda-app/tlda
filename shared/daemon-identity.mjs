// Daemon identity & isolation guards (behavior-spec §4b: a dev-rig / worktree
// daemon must never join the LIVE fleet as an already-live machine id).
//
// Two complementary moves, both pure + unit-tested here:
//   1. resolveDaemonIsolation() — daemon-side startup guard. Refuses to start
//      when an isolation signal is set but isolation is INCOMPLETE, instead of
//      silently falling through to the live config + shared machine_id. This is
//      the footgun: setting TLDA_SERVER alone does NOT isolate (the daemon still
//      reads the shared config's machineId="air" and connects to live Fly), so a
//      worktree daemon silently joins the live fleet as "air".
//   2. daemonHelloDecision() — server-side backstop. When a daemon-hello arrives
//      for a machine_id that another daemon ALREADY holds live, refuse the
//      newcomer unless it's the same install restarting. Two distinct installs
//      can never share one machine_id, no matter how the rig is misconfigured.

import { fileURLToPath } from 'node:url'

import { resolveRepoIdentity } from './repo-identity.mjs'

// A daemon script path that lives inside a git worktree — main-tree daemons run
// from <repo>/bin, worktree daemons from <repo>/.worktrees/<name>/bin,
// ~/.claude/worktrees/<name>/..., or a sibling linked checkout.
export function isWorktreePath(p) {
  if (!p) return false
  return /\/\.worktrees\//.test(p) || /\/\.claude\/worktrees\//.test(p)
}

function isDaemonWorktree(scriptPath, resolveIdentity = resolveRepoIdentity) {
  if (isWorktreePath(scriptPath)) return true
  try {
    return !!resolveIdentity(scriptPath).isWorktree
  } catch {
    return false
  }
}

export function resolveMainDaemonScript(scriptPath, resolveIdentity = resolveRepoIdentity) {
  try {
    const identity = resolveIdentity(scriptPath)
    if (identity.isWorktree && identity.mainCheckoutPath) {
      return fileURLToPath(new URL('bin/fleet-daemon.mjs', `file://${identity.mainCheckoutPath}/`))
    }
  } catch {
    // Fall through to the path-only fallback below.
  }
  const match = String(scriptPath || '').match(/^(.+?)\/(?:\.claude\/worktrees|\.worktrees)\//)
  if (match) return `${match[1]}/bin/fleet-daemon.mjs`
  return null
}

// Decide whether a daemon may start, and whether it is properly isolated.
// Inputs are plain values so this is fully testable without process/env state.
//   env:        { TLDA_DAEMON_CONFIG_DIR?, PROJECTS_DIR?, TLDA_SERVER? }
//   scriptPath: the daemon's own resolved script path (import.meta path)
//   configuredServer: active config's canonical fleet server, when known
//   targetServer: server this daemon will connect to, when known
// Returns { usingCustomConfigDir, isolated, refuseReason }. refuseReason is a
// string when the daemon must abort with a loud error, or null when it's safe.
//
// A daemon is "isolated" from the live fleet when EITHER signal is present:
//   - TLDA_DAEMON_CONFIG_DIR + PROJECTS_DIR — its own config and JSONL roots, or
//   - TLDA_SERVER            — its own server target, but only when it differs
//     from the canonical configured server or is the explicit dev-daemon target.
// The leak is a WORKTREE daemon with NEITHER: it falls through to live Fly with
// the shared machine_id ("air") and evicts the real daemon. That one is refused.
export function resolveDaemonIsolation({ env = {}, scriptPath = '', configuredServer = null, targetServer = null, resolveIdentity = resolveRepoIdentity } = {}) {
  const usingCustomConfigDir = !!env.TLDA_DAEMON_CONFIG_DIR
  const usingCustomProjectsDir = !!env.PROJECTS_DIR
  const norm = (u) => u ? String(u).replace(/\/+$/, '') : null
  const explicitServer = !!env.TLDA_SERVER
  const serverIsolated = explicitServer && (
    !configuredServer ||
    norm(targetServer || env.TLDA_SERVER) !== norm(configuredServer) ||
    !!env.TLDA_DEV_DAEMON
  )
  const customDataIsolated = usingCustomConfigDir && usingCustomProjectsDir
  const isolated = customDataIsolated || serverIsolated
  const worktree = isDaemonWorktree(scriptPath, resolveIdentity)

  if (usingCustomConfigDir && !usingCustomProjectsDir) {
    return {
      usingCustomConfigDir,
      usingCustomProjectsDir,
      isolated,
      refuseReason:
        'This daemon has TLDA_DAEMON_CONFIG_DIR but no PROJECTS_DIR. A custom ' +
        'daemon config dir must also use an isolated JSONL projects directory; ' +
        'otherwise it can bypass the singleton lock while tailing the live ' +
        'agent sessions.',
    }
  }

  if (worktree && !isolated) {
    return {
      usingCustomConfigDir,
      usingCustomProjectsDir,
      isolated,
      refuseReason:
        'This daemon is running from a git worktree (' + scriptPath + ') with no ' +
        'isolation signal. A worktree/dev-rig daemon must not join the live fleet ' +
        'as the shared machine_id (it would evict the real daemon). Set ' +
        'TLDA_DAEMON_CONFIG_DIR plus PROJECTS_DIR (own config + JSONLs) or ' +
        'TLDA_SERVER (own server target) to isolate it.',
    }
  }

  return { usingCustomConfigDir, usingCustomProjectsDir, isolated, refuseReason: null }
}

// Server-side backstop for the daemon-hello handler. Given the currently-held
// connection for a machine_id (if any) and the incoming hello, decide the action.
//   existing: null, or { open: boolean, bootId: number, installPath: string }
//   incoming: { bootId: number, installPath: string }
// Returns one of:
//   'accept'         — no live holder; take the slot.
//   'evict-existing' — same install restarting with a newer boot; replace it.
//   'refuse'         — a DIFFERENT install is live on this machine_id (rogue), or
//                      this incoming is the stale/older one; reject the newcomer.
export function daemonHelloDecision({ existing, incoming } = {}) {
  if (!existing || !existing.open) return 'accept'

  // Hard refuse ONLY when we can prove two DIFFERENT installs (both report a
  // path and they differ) — that's the rogue-worktree case. When either side
  // omits install_path (an un-upgraded daemon mid-rollout), we can't prove a
  // rogue, so fall back to the prior boot_id newer-wins behavior rather than
  // risk refusing a legitimate restart.
  const bothKnown = !!existing.installPath && !!incoming?.installPath
  if (bothKnown && existing.installPath !== incoming.installPath) {
    return 'refuse'
  }

  // Same install (or unknown) — genuine restart. Keep the newer boot, drop older.
  const existingBoot = existing.bootId || 0
  const incomingBoot = incoming?.bootId || 0
  return incomingBoot >= existingBoot ? 'evict-existing' : 'refuse'
}
