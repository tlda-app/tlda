import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'

export const PROJECT_PART_WRITEBACK_STATUSES = Object.freeze([
  'synced',
  'pending',
  'owner-unavailable',
  'owner-missing',
  'deleted',
  'conflict',
  'failed',
])

export function checkpointProjectPartWriteback({
  filePath,
  content,
  part = null,
  restore = false,
  tempPathFactory = defaultTempPath,
  backupPathFactory = defaultBackupPath,
  lockPathFactory = defaultLockPath,
  lockOptions = {},
  beforeInstall = null,
  afterInstall = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!filePath) throw new Error('checkpointProjectPartWriteback requires filePath')
  const nextContent = String(content ?? '')
  const checkedAt = now()
  const lastCleanSync = part?.metadata?.writeback?.lastCleanSync || null
  const nextSnapshot = snapshotForContent(nextContent)

  mkdirSync(dirname(filePath), { recursive: true })
  return withFileWriteLock(filePath, {
    lockPathFactory,
    lockOptions,
    onLocked: () => bounceWriteback({
      status: 'failed',
      checkedAt,
      lastCleanSync,
      current: readFileSnapshot(filePath),
      nextSnapshot,
      message: 'Backing file is already locked by another writeback',
    }),
  }, () => {
    const recovered = recoverWritebackCrashDebris(filePath, { expectedBaseline: lastCleanSync })
    if (!recovered.ok) {
      return bounceWriteback({
        status: 'failed',
        checkedAt,
        lastCleanSync,
        current: readFileSnapshot(filePath),
        nextSnapshot,
        message: recovered.message,
      })
    }
    const current = readFileSnapshot(filePath)
    const decision = decideWriteback({ current, nextContent, lastCleanSync, restore, checkedAt })
    if (!decision.ok) return decision

    if (!current.exists || current.content !== nextContent) {
      const atomic = writeFileAtomicIfUnchanged(filePath, nextContent, {
        expectedCurrent: current,
        tempPathFactory,
        backupPathFactory,
        beforeInstall,
      })
      if (!atomic.ok) {
        return bounceWriteback({
          status: 'conflict',
          checkedAt,
          lastCleanSync,
          current: atomic.current,
          nextSnapshot: snapshotForContent(nextContent),
          message: 'Backing file changed during writeback',
        })
      }
    }
    afterInstall?.()
    const synced = readFileSnapshot(filePath)
    if (!synced.exists || synced.hash !== nextSnapshot.hash) {
      return bounceWriteback({
        status: 'conflict',
        checkedAt,
        lastCleanSync,
        current: synced,
        nextSnapshot,
        message: 'Backing file changed after writeback install',
      })
    }
    cleanupWritebackBackups(filePath)
    return {
      ok: true,
      written: !current.exists || current.content !== nextContent,
      status: 'synced',
      writeback: syncedWriteback({ snapshot: synced, checkedAt }),
    }
  })
}

export function decideWriteback({ current, nextContent, lastCleanSync = null, restore = false, checkedAt = new Date().toISOString() }) {
  const nextSnapshot = snapshotForContent(nextContent)
  if (!current?.exists) {
    if (lastCleanSync && !restore) {
      return bounceWriteback({
        status: 'deleted',
        checkedAt,
        lastCleanSync,
        current,
        nextSnapshot,
        message: 'Backing file was deleted after the last clean sync',
      })
    }
    return { ok: true, status: 'pending' }
  }

  if (!lastCleanSync && current.hash !== nextSnapshot.hash) {
    return bounceWriteback({
      status: 'conflict',
      checkedAt,
      lastCleanSync: null,
      current,
      nextSnapshot,
      message: 'Backing file exists but has no last clean sync baseline',
    })
  }

  if (lastCleanSync && current.hash !== lastCleanSync.hash && current.hash !== nextSnapshot.hash) {
    return bounceWriteback({
      status: 'conflict',
      checkedAt,
      lastCleanSync,
      current,
      nextSnapshot,
      message: 'Backing file diverged after the last clean sync',
    })
  }

  return { ok: true, status: current.hash === nextSnapshot.hash ? 'synced' : 'pending' }
}

export function mergeWritebackMetadata(metadata = {}, writeback) {
  return {
    ...(metadata || {}),
    ...(writeback ? { writeback } : {}),
  }
}

export function readFileSnapshot(filePath) {
  if (!existsSync(filePath)) return { exists: false }
  const content = readFileSync(filePath, 'utf8')
  const stat = statSync(filePath)
  return {
    exists: true,
    content,
    hash: sha256(content),
    size: Buffer.byteLength(content),
    mtimeMs: stat.mtimeMs,
  }
}

export function snapshotForContent(content) {
  const text = String(content ?? '')
  return {
    hash: sha256(text),
    size: Buffer.byteLength(text),
  }
}

function syncedWriteback({ snapshot, checkedAt }) {
  return {
    status: 'synced',
    syncedAt: checkedAt,
    lastCleanSync: {
      hash: snapshot.hash,
      size: snapshot.size,
      mtimeMs: snapshot.mtimeMs,
      syncedAt: checkedAt,
    },
  }
}

function bounceWriteback({ status, checkedAt, lastCleanSync, current, nextSnapshot, message }) {
  return {
    ok: false,
    written: false,
    status,
    writeback: {
      status,
      checkedAt,
      message,
      lastCleanSync,
      current: compactSnapshot(current),
      pending: nextSnapshot,
    },
  }
}

function compactSnapshot(snapshot) {
  if (!snapshot?.exists) return { exists: false }
  return {
    exists: true,
    hash: snapshot.hash,
    size: snapshot.size,
    mtimeMs: snapshot.mtimeMs,
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

function writeFileAtomicIfUnchanged(filePath, content, {
  expectedCurrent,
  tempPathFactory = defaultTempPath,
  backupPathFactory = defaultBackupPath,
  beforeInstall = null,
} = {}) {
  const tmp = tempPathFactory(filePath)
  const backup = backupPathFactory(filePath)
  try {
    writeFileSync(tmp, content)
    return installTempIfUnchanged(filePath, tmp, backup, expectedCurrent, beforeInstall)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
      rmSync(backup, { force: true })
    } catch (cleanupError) {
      e.cleanupError = cleanupError
    }
    throw e
  }
}

function installTempIfUnchanged(filePath, tmp, backup, expectedCurrent, beforeInstall) {
  if (!expectedCurrent?.exists) {
    const current = readFileSnapshot(filePath)
    if (current.exists) {
      rmSync(tmp, { force: true })
      return { ok: false, current }
    }
    beforeInstall?.()
    try {
      linkSync(tmp, filePath)
    } catch (e) {
      if (e?.code === 'EEXIST') {
        rmSync(tmp, { force: true })
        return { ok: false, current: readFileSnapshot(filePath) }
      }
      throw e
    }
    rmSync(tmp, { force: true })
    return { ok: true }
  }

  try {
    renameSync(filePath, backup)
  } catch (e) {
    if (e?.code === 'ENOENT') {
      rmSync(tmp, { force: true })
      return { ok: false, current: { exists: false } }
    }
    throw e
  }

  const captured = readFileSnapshot(backup)
  if (!sameSnapshot(captured, expectedCurrent)) {
    restoreBackupWithoutClobber(filePath, backup)
    rmSync(tmp, { force: true })
    return { ok: false, current: captured }
  }

  beforeInstall?.()
  try {
    linkSync(tmp, filePath)
  } catch (e) {
    if (e?.code === 'EEXIST') {
      rmSync(tmp, { force: true })
      rmSync(backup, { force: true })
      return { ok: false, current: readFileSnapshot(filePath) }
    }
    restoreBackupWithoutClobber(filePath, backup)
    throw e
  }

  const finalCaptured = readFileSnapshot(backup)
  if (!sameSnapshot(finalCaptured, captured)) {
    restoreMutatedBackupAfterInstall(filePath, backup, tmp)
    rmSync(tmp, { force: true })
    return { ok: false, current: finalCaptured }
  }

  rmSync(tmp, { force: true })
  rmSync(backup, { force: true })
  return { ok: true }
}

function restoreBackupWithoutClobber(filePath, backup) {
  try {
    linkSync(backup, filePath)
    rmSync(backup, { force: true })
    return true
  } catch (e) {
    if (e?.code === 'EEXIST') {
      rmSync(backup, { force: true })
      return false
    }
    throw e
  }
}

function restoreMutatedBackupAfterInstall(filePath, backup, tmp) {
  const current = readFileSnapshot(filePath)
  const installed = readFileSnapshot(tmp)
  if (!sameSnapshot(current, installed)) return false
  rmSync(filePath, { force: true })
  try {
    linkSync(backup, filePath)
    rmSync(backup, { force: true })
    return true
  } catch (e) {
    if (e?.code === 'EEXIST') return false
    throw e
  }
}

function recoverWritebackCrashDebris(filePath, { expectedBaseline = null } = {}) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) return { ok: true, recovered: false }

  const name = basename(filePath)
  const backups = readdirSync(dir)
    .filter(entry => entry.startsWith(`.${name}.backup-`))
    .map(entry => join(dir, entry))
  const temps = readdirSync(dir)
    .filter(entry => entry.startsWith(`.${name}.tmp-`))
    .map(entry => join(dir, entry))

  if (!backups.length && !temps.length) return { ok: true, recovered: false }

  if (existsSync(filePath)) {
    for (const tmp of temps) rmSync(tmp, { force: true })
    cleanupWritebackBackups(filePath)
    return { ok: true, recovered: false }
  }

  if (backups.length > 1) {
    return {
      ok: false,
      recovered: false,
      message: `Multiple writeback backups found for missing backing file: ${backups.map(path => basename(path)).join(', ')}`,
    }
  }

  if (backups.length === 1) {
    const backupSnapshot = readFileSnapshot(backups[0])
    if (expectedBaseline && !matchesBaseline(backupSnapshot, expectedBaseline)) {
      for (const tmp of temps) rmSync(tmp, { force: true })
      return { ok: true, recovered: false }
    }
    try {
      linkSync(backups[0], filePath)
      rmSync(backups[0], { force: true })
      for (const tmp of temps) rmSync(tmp, { force: true })
      return { ok: true, recovered: true }
    } catch (e) {
      if (e?.code === 'EEXIST') return { ok: true, recovered: false }
      throw e
    }
  }

  for (const tmp of temps) rmSync(tmp, { force: true })
  return {
    ok: false,
    recovered: false,
    message: 'Writeback temp file remained after crash without a recoverable backup',
  }
}

function cleanupWritebackBackups(filePath) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) return
  const name = basename(filePath)
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`.${name}.backup-`)) {
      rmSync(join(dir, entry), { force: true })
    }
  }
}

function withFileWriteLock(filePath, { lockPathFactory = defaultLockPath, lockOptions = {}, onLocked } = {}, fn) {
  const lockPath = lockPathFactory(filePath)
  let compromisedError = null
  let release
  try {
    release = lockfile.lockSync(filePath, {
      // The 10s staleness lets a crashed writer's lock be reclaimed. Residual:
      // if a writer blocks the event loop synchronously for longer than this,
      // another writer can reclaim the "stale" lock and both can write before
      // the first throws ENOENT; onCompromised cannot fire while the loop is
      // blocked. Local small-file writes use sub-ms sync fs ops, so this becomes
      // real only if project roots move to NFS and the server stalls past the
      // stale window. If that deployment lands, raise stale or move writeback
      // off the event loop with async locking.
      stale: 10000,
      update: 5000,
      realpath: false,
      lockfilePath: lockPath,
      onCompromised: (err) => {
        compromisedError = err
      },
      ...lockOptions,
    })
  } catch (e) {
    if (e?.code === 'ELOCKED') return onLocked()
    throw e
  }

  let result
  try {
    result = fn()
    if (compromisedError) throw compromisedError
  } catch (e) {
    try {
      release()
    } catch (cleanupError) {
      e.cleanupError = cleanupError
    }
    throw e
  }

  try {
    release()
  } catch (cleanupError) {
    const e = new Error(`Failed to release writeback lock: ${lockPath}`)
    e.cleanupError = cleanupError
    throw e
  }
  return result
}

function sameSnapshot(left, right) {
  if (!left?.exists && !right?.exists) return true
  if (!left?.exists || !right?.exists) return false
  return left.hash === right.hash && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function matchesBaseline(snapshot, baseline) {
  if (!snapshot?.exists || !baseline) return false
  if (snapshot.hash !== baseline.hash || snapshot.size !== baseline.size) return false
  return baseline.mtimeMs == null || snapshot.mtimeMs === baseline.mtimeMs
}

function defaultTempPath(filePath) {
  const dir = dirname(filePath)
  return join(dir, `.${basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

function defaultBackupPath(filePath) {
  const dir = dirname(filePath)
  return join(dir, `.${basename(filePath)}.backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

function defaultLockPath(filePath) {
  const dir = dirname(filePath)
  return join(dir, `.${basename(filePath)}.writeback.lock`)
}
