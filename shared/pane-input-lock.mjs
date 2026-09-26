// Per-pane serialization for synthetic terminal input.
//
// Every normal synthetic writer -- the agent MCP sidecar and the daemon --
// acquires a pane's lock around its COMPLETE inject-to-submit transaction.
// The lock is an OS advisory lock (a directory claim), not `tmux wait-for`:
// measured 2026-09-25, a `wait-for -L` lock survives its holder's death and
// blocks the next acquirer indefinitely, which would wedge the pane's input
// on any crash. A directory claim is stealable when its owner is provably
// dead or impossibly old, so a crash self-heals on the next acquire.
//
// The lock directory is a FIXED /tmp path, never os.tmpdir(): sidecar and
// daemon run under different TMPDIRs (fenced agent envs isolate temp), and
// the lock only works if all writers meet in the same directory. The writers
// already share the machine by construction -- they all shell to the same
// tmux server -- so a machine-local rendezvous is exactly right.
//
// Takeover is atomic: exactly one contender renames a stale claim away (rename
// is atomic; the loser gets ENOENT and loops back to acquire). Release verifies
// ownership by token, so a hung holder waking after a takeover cannot delete
// the new owner's lock -- though its in-flight keystrokes may still land, which
// is why takeovers log loudly.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const PANE_INPUT_LOCK_ENV_DIR = 'TLDA_PANE_INPUT_DIR'
export const PANE_INPUT_LOCK_DIR = '/tmp/tlda-pane-input'
// A legitimate transaction holds seconds (type, settle, submit, verify).
// Anything this old is hung; stealing it is recovery, not racing.
export const PANE_INPUT_HOLD_TIMEOUT_MS = 120_000
// Break-glass (explicit daemon recovery) steals sooner, and says so.
export const PANE_INPUT_BREAKGLASS_STEAL_MS = 10_000
export const PANE_INPUT_ACQUIRE_POLL_MS = 100

export function paneInputLockDir() {
  return process.env[PANE_INPUT_LOCK_ENV_DIR] || PANE_INPUT_LOCK_DIR
}

function lockPathFor(session, dir = paneInputLockDir()) {
  return path.join(dir, `${encodeURIComponent(String(session))}.d`)
}

function ownerFileFor(lockPath) {
  return path.join(lockPath, 'owner.json')
}

export function parkFileFor(session, dir = paneInputLockDir()) {
  return path.join(dir, `${encodeURIComponent(String(session))}.park.json`)
}

function pidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    // ESRCH: no such process (dead). Anything else (EPERM, EINVAL):
    // conservative -- treat as alive and let the age rule decide.
    return e?.code === 'ESRCH'
  }
}

function readOwner(lockPath) {
  try {
    const raw = fs.readFileSync(ownerFileFor(lockPath), 'utf8')
    const owner = JSON.parse(raw)
    if (!owner || typeof owner !== 'object' || !owner.token) return null
    return owner
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class PaneInputLockTimeout extends Error {
  constructor(session, holder) {
    super(`pane input lock for ${session} stayed held${holder ? ` by pid ${holder.pid} (${holder.op || 'unknown op'})` : ''}`)
    this.code = 'PANE_INPUT_LOCK_TIMEOUT'
    this.session = session
    this.holder = holder || null
  }
}

function ensureDir(dir, log) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    log?.warn?.(`[pane-input-lock] cannot create ${dir}: ${e.message}`)
    throw e
  }
}

/**
 * Acquire the synthetic-input lock for a tmux session, held across one
 * complete transaction. Resolves to { release, token, stole }.
 * Throws PaneInputLockTimeout when the timeout expires first.
 */
export async function acquirePaneInputLock(session, {
  timeoutMs = 30_000,
  pollMs = PANE_INPUT_ACQUIRE_POLL_MS,
  op = 'input',
  breakGlass = false,
  dir = paneInputLockDir(),
  log = console,
} = {}) {
  if (!session) throw new Error('pane input lock requires a session')
  const token = crypto.randomUUID()
  const lockPath = lockPathFor(session, dir)
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  const stealAfterMs = breakGlass ? PANE_INPUT_BREAKGLASS_STEAL_MS : PANE_INPUT_HOLD_TIMEOUT_MS
  let stole = false
  ensureDir(dir, log)

  for (;;) {
    try {
      fs.mkdirSync(lockPath)
      try {
        fs.writeFileSync(ownerFileFor(lockPath), JSON.stringify({
          token, pid: process.pid, op, since: Date.now(),
        }))
      } catch (e) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true })
        } catch (rmErr) {
          // Rollback best-effort: the original write error below is what
          // propagates. A leaked claim dir self-heals on the next acquire
          // via the stale-takeover path, but loudly.
          log?.warn?.(`[pane-input-lock] claim rollback for ${session} failed: ${rmErr.message}`)
        }
        throw e
      }
      const release = () => releasePaneInputLock(session, token, { dir, log })
      return { release, token, stole }
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }

    const owner = readOwner(lockPath)
    const age = owner?.since ? Date.now() - owner.since : Infinity
    const dead = !owner || pidDead(owner.pid)
    if (dead || age > stealAfterMs) {
      // Atomic takeover: exactly one contender renames the stale claim away.
      const staleName = `${lockPath}.stale.${token}`
      try {
        fs.renameSync(lockPath, staleName)
        stole = true
        log?.warn?.(`[pane-input-lock] stole ${breakGlass ? 'break-glass ' : ''}stale lock for ${session} (owner pid ${owner?.pid ?? '?'}, op ${owner?.op ?? '?'}, age ${Number.isFinite(age) ? `${Math.round(age / 1000)}s` : 'unknown'}, ${dead ? 'owner dead' : 'over hold timeout'})`)
        try {
          fs.rmSync(staleName, { recursive: true, force: true })
        } catch (rmErr) {
          // Stale-dir cleanup is inert litter removal; a leftover is never
          // read as a live claim (only *.d wins acquire), so warn and move on.
          log?.warn?.(`[pane-input-lock] stale cleanup for ${session} failed: ${rmErr.message}`)
        }
      } catch (renameErr) {
        // Lost the takeover race (or the holder released mid-read): loop back.
        if (renameErr?.code !== 'ENOENT') {
          log?.warn?.(`[pane-input-lock] takeover rename for ${session} failed: ${renameErr.message}`)
        }
      }
      continue
    }

    if (Date.now() >= deadline) throw new PaneInputLockTimeout(session, owner)
    await sleep(Math.max(10, pollMs))
  }
}

export function releasePaneInputLock(session, token, { dir = paneInputLockDir(), log = console } = {}) {
  const lockPath = lockPathFor(session, dir)
  const owner = readOwner(lockPath)
  if (!owner) return false
  if (owner.token !== token) {
    log?.warn?.(`[pane-input-lock] not releasing ${session}: lock belongs to another transaction (takeover won while we held it)`)
    return false
  }
  try {
    fs.rmSync(lockPath, { recursive: true, force: true })
  } catch (e) {
    log?.warn?.(`[pane-input-lock] release of ${session} failed: ${e.message}`)
    return false
  }
  return true
}

/**
 * Break-glass: unconditionally clear a pane's input lock. Daemon recovery
 * only. Loud by construction: clearing a live holder's lock lets two
 * writers interleave, so the reason must say why that was acceptable.
 */
export function forceClearPaneInputLock(session, reason, { dir = paneInputLockDir(), log = console } = {}) {
  const lockPath = lockPathFor(session, dir)
  const owner = readOwner(lockPath)
  log?.warn?.(`[pane-input-lock] BREAK-GLASS clear of ${session}: ${reason || 'no reason given'} (previous owner pid ${owner?.pid ?? 'none'}, op ${owner?.op ?? 'none'})`)
  try {
    fs.rmSync(lockPath, { recursive: true, force: true })
  } catch (e) {
    log?.warn?.(`[pane-input-lock] break-glass clear of ${session} failed: ${e.message}`)
  }
  return owner || null
}

export function readPaneInputLock(session, { dir = paneInputLockDir() } = {}) {
  return readOwner(lockPathFor(session, dir))
}

// Parked-wake record: the last doorbell text left sitting in a pane's
// composer, with its park time. Any sidecar may adopt (submit) a stale park,
// which is what keeps a crashed parker from wedging the wake forever.
export function readParkedWake(session, { dir = paneInputLockDir() } = {}) {
  try {
    const raw = fs.readFileSync(parkFileFor(session, dir), 'utf8')
    const park = JSON.parse(raw)
    if (!park || typeof park.line !== 'string') return null
    return park
  } catch {
    return null
  }
}

export function writeParkedWake(session, line, { dir = paneInputLockDir() } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${parkFileFor(session, dir)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ line, at: Date.now(), pid: process.pid }))
    fs.renameSync(tmp, parkFileFor(session, dir))
  } catch {
    // Park bookkeeping must never fail a wake; the worst case is a missed
    // adoption, which the next notice retries.
  }
}

export function clearParkedWake(session, { dir = paneInputLockDir(), log = console } = {}) {
  try {
    fs.rmSync(parkFileFor(session, dir), { force: true })
  } catch (e) {
    // Best-effort: a leftover record only matters when the composer holds
    // 📬-led text, and then adoption still verifies stillness first.
    log?.warn?.(`[pane-input-lock] park clear for ${session} failed: ${e.message}`)
  }
}
