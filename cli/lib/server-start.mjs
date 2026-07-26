/**
 * Robust detached unified-server spawn — the ONE place that knows how to launch
 * `server/unified-server.mjs` so it survives the launching agent exiting.
 *
 * This is the canonical daemonization the project keeps relearning the hard way:
 * an ad-hoc `node server/unified-server.mjs &` keeps the child in the agent's
 * tmux/shell process group with stdio tied to the pane, so it gets SIGHUP'd and
 * dies "after a couple minutes" when the agent hibernates or the pane closes.
 * The cure is: detached + unref'd + stdio redirected to a log file + the TMUX
 * env scrubbed so there's no pane association left to hang up on.
 *
 * `tlda server start` (non-launchd path) and `tlda-dev serve` both call this, so
 * the worktree dev server is daemonized exactly like the real one instead of
 * hand-rolling a parallel spawn (which is the very thing that crashes). The
 * launchd path on Skip's machine does NOT use this — launchd owns that instance.
 */

import { spawn, execSync } from 'child_process'
import { openSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveServerIsolation } from '../../shared/server-identity.mjs'

// Spawn unified-server.mjs fully detached. Returns the child pid.
//   serverScript  absolute path to server/unified-server.mjs (this checkout's)
//   port          PORT to bind
//   logFile       stdout+stderr go here (created if missing); null → /dev/null
//   env           extra env merged over process.env (e.g. TLDA_ENV, PROJECTS_DIR)
//   extraCaPath   NODE_EXTRA_CA_CERTS to set when TLS is on and it isn't already
//   reclaimPort   SIGKILL a stale LISTENer on `port` first (true for the fixed
//                 main port; FALSE for a dev server on an already-free port — we
//                 must never kill an unrelated process squatting a random port)
//   pidFile       if set, write the child pid here for status/stop
export function spawnDetachedServer({ serverScript, port, logFile = null, env = {}, extraCaPath = null, reclaimPort = false, pidFile = null }) {
  if (!existsSync(serverScript)) throw new Error(`server script not found: ${serverScript}`)
  const childEnv = {
    ...process.env,
    ...env,
    PORT: String(port),
    // Sever any tmux-pane association so a hibernating agent's SIGHUP can't
    // reap this server. This is the difference between a real daemon and the
    // zombie that `node … &` produces.
    TMUX: undefined,
    TMUX_PANE: undefined,
    ...(extraCaPath && !process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: extraCaPath } : {}),
  }
  const isolation = resolveServerIsolation({ env: childEnv, scriptPath: serverScript })
  if (isolation.refuseReason) throw new Error(isolation.refuseReason)
  if (logFile && !existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true })

  if (reclaimPort) {
    // Only for a fixed, known-ours port. Reclaim a genuinely-dead LISTENer so a
    // crashed predecessor doesn't block the bind.
    try {
      const stale = execSync(`lsof -ti:${port} -sTCP:LISTEN`, { stdio: 'pipe' }).toString().trim()
      const pids = stale ? stale.split('\n') : []
      for (const pid of pids) {
        try { process.kill(parseInt(pid, 10), 'SIGKILL') } catch { /* already gone */ }
      }
      // Let the OS release the port before the fresh bind races it.
      if (pids.length) { try { execSync('sleep 0.5') } catch { /* best effort */ } }
    } catch { /* lsof exits non-zero when nothing is listening — nothing to reclaim */ }
  }

  const logFd = logFile ? openSync(logFile, 'a') : 'ignore'
  const child = spawn('node', [serverScript, '--i-am-tlda-cli'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: childEnv,
  })
  child.unref()
  if (pidFile) {
    if (!existsSync(dirname(pidFile))) mkdirSync(dirname(pidFile), { recursive: true })
    writeFileSync(pidFile, String(child.pid))
  }
  return child.pid
}
