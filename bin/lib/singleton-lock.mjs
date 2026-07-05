/**
 * Per-origin singleton lock for the fleet-daemon.
 *
 * THE INVARIANT: at most ONE fleet-daemon process per active fleet origin on a
 * machine — no matter which install/worktree's `bin/fleet-daemon.mjs` is
 * launched. This must be STRUCTURALLY impossible to violate: a second same-origin
 * daemon is refused UP FRONT, before it opens any WebSocket to the server — not
 * "evicted by the server 10s later". The old server-side machine_id lease only
 * evicted the loser *after* it had already connected and started fighting over
 * the slot; this lock stops the second same-origin process before it ever gets
 * that far.
 *
 * Mechanism (darwin, the deployment target — the Mac Mini): an exclusive,
 * non-blocking advisory file lock via open(2) with O_EXLOCK|O_NONBLOCK on a
 * install-path-agnostic path derived from CONFIG_DIR + the normalized fleet
 * origin, NOT from __dirname. Because the path depends only on the machine's
 * config dir and target origin, every install/worktree aimed at that origin
 * contends for the SAME lock, while different origins can run side by side.
 *
 * Why a kernel lock and not the pw-lock.sh advisory-file pattern: pw-lock is a
 * cooperative timestamp+pid file built for QUEUE-not-steal playwright sessions —
 * it is intentionally steal-able and has a read-then-write TOCTOU window. That
 * is the wrong shape for a hard "structurally impossible" invariant. O_EXLOCK is
 * a real kernel lock: the contended open() fails atomically (EAGAIN) with no
 * race, and the lock is released automatically by the kernel when the holding
 * process dies — so a crashed daemon's lock is reclaimed with zero stale-pid
 * bookkeeping.
 *
 * Node does not expose fs.constants.O_EXLOCK, but Node's openSync passes the
 * flag bits straight to open(2), so we OR in the documented darwin value (0x20).
 *
 * Non-darwin fallback: a pid-file liveness check (refuse if the recorded pid is
 * alive, otherwise reclaim). Racy, but it is only the fallback; the real
 * deployment is darwin and gets the kernel lock.
 */

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

// open(2) flag bits. fs.constants has these on darwin EXCEPT O_EXLOCK, which
// Node never exposes — so we hardcode the darwin value and OR it in by hand.
const O_EXLOCK_DARWIN = 0x20

/**
 * Compute the daemon singleton lock path for a fleet origin.
 */
export function daemonSingletonLockPath({ configDir, origin }) {
  const normalized = normalizeLockOrigin(origin)
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  return path.join(configDir, `fleet-daemon.${digest}.lock`)
}

export function sessionReaderLockPath({ configDir }) {
  if (!configDir) throw new Error('session reader lock requires configDir')
  return path.join(configDir, 'session-reader.lock')
}

export function normalizeLockOrigin(origin) {
  const raw = String(origin || '').trim()
  if (!raw) throw new Error('daemon singleton lock requires a non-empty origin')
  return new URL(raw).origin
}

/**
 * Acquire the daemon singleton lock.
 *
 * @param {object} opts
 * @param {string} opts.lockPath    — origin-keyed, install-path-agnostic lock file path
 * @param {string} opts.installPath — this daemon's install/worktree path (for the holder record)
 * @returns {{ ok: true, fd: number } | { ok: false, holder: { pid?: number, installPath?: string, origin?: string, startedAt?: number } }}
 *   On success, `fd` MUST be kept open for the lifetime of the process — closing
 *   it (or exiting) releases the lock. On failure, `holder` describes whoever
 *   currently holds it (best-effort; fields may be missing if the record is
 *   unreadable).
 */
export function acquireSingletonLock({ lockPath, installPath, origin = null }) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  if (process.platform === 'darwin') {
    return acquireExlock({ lockPath, installPath, origin })
  }
  return acquirePidfileFallback({ lockPath, installPath, origin })
}

/**
 * Inspect whether a daemon singleton lock is currently held.
 *
 * This is for supervisors that need to decide whether to launch a daemon. On
 * darwin, use the same kernel lock as acquireSingletonLock: if a non-blocking
 * exclusive open fails, the lock is held by a live process. If it succeeds, no
 * daemon currently holds the lock, and the probe immediately closes the fd.
 *
 * @param {object} opts
 * @param {string} opts.lockPath
 * @returns {{ held: boolean, holder: { pid?: number, installPath?: string, origin?: string, startedAt?: number } }}
 */
export function inspectSingletonLock({ lockPath }) {
  const holder = readHolder(lockPath)
  if (process.platform === 'darwin') {
    return inspectExlock({ lockPath, holder })
  }
  return inspectPidfileFallback({ holder })
}

function readHolder(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    return {}
  }
}

function writeHolder(fd, installPath, origin = null) {
  const record = JSON.stringify({
    pid: process.pid,
    installPath,
    ...(origin ? { origin: normalizeLockOrigin(origin) } : {}),
    startedAt: Date.now(),
  })
  fs.ftruncateSync(fd, 0)
  fs.writeSync(fd, record, 0, 'utf8')
  try { fs.fsyncSync(fd) } catch { /* best effort */ }
}

function acquireExlock({ lockPath, installPath, origin }) {
  // O_RDWR|O_CREAT (no O_TRUNC, so the holder record survives for refusers to
  // read) | O_EXLOCK (exclusive advisory lock) | O_NONBLOCK (fail fast instead
  // of blocking if another process holds it).
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT |
    O_EXLOCK_DARWIN | fs.constants.O_NONBLOCK
  let fd
  try {
    fd = fs.openSync(lockPath, flags, 0o644)
  } catch (e) {
    if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') {
      // Held by a live process — the kernel would have released it on the
      // holder's death, so a refusal here means a genuinely live holder.
      return { ok: false, holder: readHolder(lockPath) }
    }
    throw e
  }
  writeHolder(fd, installPath, origin)
  return { ok: true, fd }
}

function inspectExlock({ lockPath, holder }) {
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT |
    O_EXLOCK_DARWIN | fs.constants.O_NONBLOCK
  let fd
  try {
    fd = fs.openSync(lockPath, flags, 0o644)
  } catch (e) {
    if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') {
      return { held: true, holder }
    }
    throw e
  }
  try {
    fs.closeSync(fd)
  } catch { /* best effort */ }
  return { held: false, holder }
}

function acquirePidfileFallback({ lockPath, installPath, origin }) {
  const existing = readHolder(lockPath)
  if (existing && existing.pid && existing.pid !== process.pid) {
    try {
      process.kill(existing.pid, 0) // existence check only
      return { ok: false, holder: existing } // alive → refuse
    } catch { /* dead → reclaim below */ }
  }
  const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644)
  writeHolder(fd, installPath, origin)
  return { ok: true, fd }
}

function inspectPidfileFallback({ holder }) {
  if (holder && holder.pid && holder.pid !== process.pid) {
    try {
      process.kill(holder.pid, 0)
      return { held: true, holder }
    } catch { /* expected: pid liveness probe says holder is dead */ }
  }
  return { held: false, holder }
}
