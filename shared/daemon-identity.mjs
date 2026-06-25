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

// A daemon script path that lives inside a git worktree — main-tree daemons run
// from <repo>/bin, worktree daemons from <repo>/.worktrees/<name>/bin or
// ~/.claude/worktrees/<name>/...
export function isWorktreePath(p) {
  if (!p) return false
  return /\/\.worktrees\//.test(p) || /\/\.claude\/worktrees\//.test(p)
}

// Decide whether a daemon may start, and whether it is properly isolated.
// Inputs are plain values so this is fully testable without process/env state.
//   env:        { TLDA_DAEMON_CONFIG_DIR?, TLDA_SERVER? }
//   scriptPath: the daemon's own resolved script path (import.meta path)
// Returns { usingCustomConfigDir, isolated, refuseReason }. refuseReason is a
// string when the daemon must abort with a loud error, or null when it's safe.
//
// A daemon is "isolated" from the live fleet when EITHER signal is present:
//   - TLDA_DAEMON_CONFIG_DIR — its own config dir (own machine_id), or
//   - TLDA_SERVER            — its own server target (honored by the daemon's
//     SERVER resolution, so it never reaches the live Fly instance).
// The leak is a WORKTREE daemon with NEITHER: it falls through to live Fly with
// the shared machine_id ("air") and evicts the real daemon. That one is refused.
export function resolveDaemonIsolation({ env = {}, scriptPath = '' } = {}) {
  const usingCustomConfigDir = !!env.TLDA_DAEMON_CONFIG_DIR
  const isolated = usingCustomConfigDir || !!env.TLDA_SERVER

  if (isWorktreePath(scriptPath) && !isolated) {
    return {
      usingCustomConfigDir,
      isolated,
      refuseReason:
        'This daemon is running from a git worktree (' + scriptPath + ') with no ' +
        'isolation signal. A worktree/dev-rig daemon must not join the live fleet ' +
        'as the shared machine_id (it would evict the real daemon). Set ' +
        'TLDA_DAEMON_CONFIG_DIR (own config + machine_id) or TLDA_SERVER (own ' +
        'server target) to isolate it.',
    }
  }

  return { usingCustomConfigDir, isolated, refuseReason: null }
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
