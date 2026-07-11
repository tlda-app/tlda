import assert from 'node:assert/strict'
import test from 'node:test'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  checkpointProjectPartWriteback,
  snapshotForContent,
} from '../server/lib/project-part-writeback.mjs'

test('checkpointProjectPartWriteback records last clean sync for a file write', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-sync-'))
  const filePath = join(root, 'notes', 'note.md')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: '# Note\n',
    now: () => '2026-07-05T10:00:00.000Z',
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'synced')
  assert.equal(readFileSync(filePath, 'utf8'), '# Note\n')
  assert.equal(result.writeback.status, 'synced')
  assert.equal(result.writeback.lastCleanSync.hash, snapshotForContent('# Note\n').hash)
  assert.equal(result.writeback.lastCleanSync.syncedAt, '2026-07-05T10:00:00.000Z')
})

test('checkpointProjectPartWriteback first materialization writes when no file exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-first-'))
  const filePath = join(root, 'note.md')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'first\n',
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'synced')
  assert.equal(result.written, true)
  assert.equal(readFileSync(filePath, 'utf8'), 'first\n')
})

test('checkpointProjectPartWriteback fails closed when existing file has no baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-no-baseline-'))
  const filePath = join(root, 'note.md')
  writeFileSync(filePath, 'external text\n')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app text\n',
    part: { metadata: { writeback: { status: 'pending' } } },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'conflict')
  assert.equal(result.written, false)
  assert.equal(readFileSync(filePath, 'utf8'), 'external text\n')
  assert.equal(result.writeback.status, 'conflict')
  assert.equal(result.writeback.lastCleanSync, null)
  assert.equal(result.writeback.current.hash, snapshotForContent('external text\n').hash)
  assert.equal(result.writeback.pending.hash, snapshotForContent('app text\n').hash)
})

test('checkpointProjectPartWriteback refuses to clobber a diverged backing file', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-conflict-'))
  const filePath = join(root, 'note.md')
  writeFileSync(filePath, 'clean\n')
  const lastCleanSync = snapshotForContent('clean\n')
  writeFileSync(filePath, 'external edit\n')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
    now: () => '2026-07-05T10:01:00.000Z',
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'conflict')
  assert.equal(readFileSync(filePath, 'utf8'), 'external edit\n')
  assert.equal(result.writeback.status, 'conflict')
  assert.equal(result.writeback.current.hash, snapshotForContent('external edit\n').hash)
  assert.equal(result.writeback.pending.hash, snapshotForContent('app edit\n').hash)
})

test('checkpointProjectPartWriteback treats deleted backing file as visible delete state', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-deleted-'))
  const filePath = join(root, 'note.md')
  mkdirSync(root, { recursive: true })
  writeFileSync(filePath, 'clean\n')
  const lastCleanSync = snapshotForContent('clean\n')
  unlinkSync(filePath)

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'deleted')
  assert.equal(existsSync(filePath), false)
  assert.equal(result.writeback.status, 'deleted')
})

test('checkpointProjectPartWriteback uses temp rename without corrupting original on failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-atomic-'))
  const filePath = join(root, 'note.md')
  const badTemp = join(root, 'bad-temp-dir')
  mkdirSync(badTemp)
  writeFileSync(filePath, 'clean\n')
  const lastCleanSync = snapshotForContent('clean\n')

  assert.throws(
    () => checkpointProjectPartWriteback({
      filePath,
      content: 'new text\n',
      part: { metadata: { writeback: { lastCleanSync } } },
      tempPathFactory: () => badTemp,
      now: () => '2026-07-05T10:02:00.000Z',
    }),
    /EISDIR|ENOTDIR|EEXIST|EACCES|EPERM/,
  )

  assert.equal(readFileSync(filePath, 'utf8'), 'clean\n')
  assert.deepEqual(readdirSync(root).sort(), ['bad-temp-dir', 'note.md'])
})

test('checkpointProjectPartWriteback fails closed when file changes after final write check', () => {
  const oldRoot = mkdtempSync(join(tmpdir(), 'part-writeback-old-race-'))
  const oldFilePath = join(oldRoot, 'note.md')
  writeFileSync(oldFilePath, 'clean\n')
  const lastCleanSync = snapshotForContent('clean\n')
  const oldTmpPath = join(oldRoot, '.note.md.legacy-race-tmp')

  const oldResult = legacyCheckpointForRaceRepro({
    filePath: oldFilePath,
    content: 'app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
    tempPathFactory: () => oldTmpPath,
    afterFinalCheck: () => writeFileSync(oldFilePath, 'competing edit after final check\n'),
  })

  assert.equal(oldResult.ok, true)
  assert.equal(oldResult.status, 'synced')
  assert.equal(oldResult.writeback.lastCleanSync.hash, snapshotForContent('app edit\n').hash)
  assert.equal(readFileSync(oldFilePath, 'utf8'), 'app edit\n')

  const newRoot = mkdtempSync(join(tmpdir(), 'part-writeback-new-race-'))
  const newFilePath = join(newRoot, 'note.md')
  const newTmpPath = join(newRoot, '.note.md.new-race-tmp')
  writeFileSync(newFilePath, 'clean\n')

  const newResult = checkpointProjectPartWriteback({
    filePath: newFilePath,
    content: 'app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
    tempPathFactory: () => newTmpPath,
    beforeInstall: () => writeFileSync(newFilePath, 'competing edit after final check\n'),
    now: () => '2026-07-05T10:03:00.000Z',
  })

  assert.equal(newResult.ok, false)
  assert.equal(newResult.status, 'conflict')
  assert.equal(newResult.writeback.status, 'conflict')
  assert.equal(newResult.writeback.message, 'Backing file changed during writeback')
  assert.equal(newResult.writeback.current.hash, snapshotForContent('competing edit after final check\n').hash)
  assert.equal(newResult.writeback.pending.hash, snapshotForContent('app edit\n').hash)
  assert.equal(readFileSync(newFilePath, 'utf8'), 'competing edit after final check\n')
  assert.deepEqual(readdirSync(newRoot).sort(), ['note.md'])
})

test('checkpointProjectPartWriteback does not mark synced when file changes after install', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-after-install-'))
  const filePath = join(root, 'note.md')
  writeFileSync(filePath, 'clean\n')
  const lastCleanSync = snapshotForContent('clean\n')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
    afterInstall: () => writeFileSync(filePath, 'external edit after install\n'),
    now: () => '2026-07-05T10:04:00.000Z',
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'conflict')
  assert.equal(result.writeback.message, 'Backing file changed after writeback install')
  assert.equal(result.writeback.current.hash, snapshotForContent('external edit after install\n').hash)
  assert.equal(result.writeback.pending.hash, snapshotForContent('app edit\n').hash)
  assert.equal(readFileSync(filePath, 'utf8'), 'external edit after install\n')
})

test('checkpointProjectPartWriteback fails closed when open fd mutates captured backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-open-fd-'))
  const filePath = join(root, 'note.md')
  const backupPath = join(root, '.note.md.review-backup')
  writeFileSync(filePath, 'clean\n')
  const fd = openSync(filePath, 'r+')
  const lastCleanSync = snapshotForContent('clean\n')
  try {
    const result = checkpointProjectPartWriteback({
      filePath,
      content: 'app edit\n',
      part: { metadata: { writeback: { lastCleanSync } } },
      backupPathFactory: () => backupPath,
      beforeInstall: () => writeSync(fd, 'fd edit while backup exists\n', 0),
      now: () => '2026-07-05T10:05:00.000Z',
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'conflict')
    assert.equal(result.writeback.message, 'Backing file changed during writeback')
    assert.equal(result.writeback.current.hash, snapshotForContent('fd edit while backup exists\n').hash)
    assert.equal(result.writeback.pending.hash, snapshotForContent('app edit\n').hash)
    assert.equal(readFileSync(filePath, 'utf8'), 'app edit\n')
    assert.equal(readFileSync(backupPath, 'utf8'), 'fd edit while backup exists\n')
  } finally {
    closeSync(fd)
  }
})

test('checkpointProjectPartWriteback fails closed while another writer holds the file lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-lock-held-'))
  const filePath = join(root, 'note.md')
  const lockPath = join(root, '.note.md.writeback.lock')
  writeFileSync(filePath, 'clean\n')
  mkdirSync(lockPath)
  const lastCleanSync = snapshotForContent('clean\n')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.written, false)
  assert.equal(result.writeback.message, 'Backing file is already locked by another writeback')
  assert.equal(readFileSync(filePath, 'utf8'), 'clean\n')
  assert.equal(existsSync(lockPath), true)
})

test('checkpointProjectPartWriteback reclaims stale lock left by crashed writer', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-stale-lock-'))
  const filePath = join(root, 'note.md')
  const lockPath = join(root, '.note.md.writeback.lock')
  writeFileSync(filePath, 'clean\n')
  mkdirSync(lockPath)
  const staleAt = new Date(Date.now() - 10_000)
  utimesSync(lockPath, staleAt, staleAt)
  const lastCleanSync = snapshotForContent('clean\n')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app edit after crash\n',
    part: { metadata: { writeback: { lastCleanSync } } },
    lockOptions: {
      stale: 2000,
      update: 1000,
      retries: 0,
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'synced')
  assert.equal(readFileSync(filePath, 'utf8'), 'app edit after crash\n')
  assert.equal(existsSync(lockPath), false)
  assert.equal(result.writeback.lastCleanSync.hash, snapshotForContent('app edit after crash\n').hash)
})

test('checkpointProjectPartWriteback recovers backup left by kill mid install', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-kill-install-'))
  const filePath = join(root, 'note.md')
  const backupPath = join(root, '.note.md.backup-crashed')
  const tmpPath = join(root, '.note.md.tmp-crashed')
  const lockPath = join(root, '.note.md.writeback.lock')
  writeFileSync(filePath, 'clean\n')
  const lastCleanSync = snapshotForContent('clean\n')

  renameSync(filePath, backupPath)
  writeFileSync(tmpPath, 'interrupted app edit\n')
  mkdirSync(lockPath)
  const staleAt = new Date(Date.now() - 10_000)
  utimesSync(lockPath, staleAt, staleAt)

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app edit after restart\n',
    part: { metadata: { writeback: { lastCleanSync } } },
    lockOptions: {
      stale: 2000,
      update: 1000,
    },
    now: () => '2026-07-05T10:06:00.000Z',
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'synced')
  assert.equal(readFileSync(filePath, 'utf8'), 'app edit after restart\n')
  assert.equal(existsSync(backupPath), false)
  assert.equal(existsSync(tmpPath), false)
  assert.equal(existsSync(lockPath), false)
  assert.equal(result.writeback.lastCleanSync.hash, snapshotForContent('app edit after restart\n').hash)
})

test('checkpointProjectPartWriteback fails closed on multiple crash backups without throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-multiple-backups-'))
  const filePath = join(root, 'note.md')
  writeFileSync(join(root, '.note.md.backup-one'), 'clean\n')
  writeFileSync(join(root, '.note.md.backup-two'), 'clean\n')
  const lastCleanSync = snapshotForContent('clean\n')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
    now: () => '2026-07-05T10:07:00.000Z',
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.match(result.writeback.message, /Multiple writeback backups/)
  assert.equal(result.writeback.pending.hash, snapshotForContent('app edit\n').hash)
  assert.equal(existsSync(filePath), false)
})

test('checkpointProjectPartWriteback treats stale backup after legitimate delete as deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-legit-delete-'))
  const filePath = join(root, 'note.md')
  const backupPath = join(root, '.note.md.backup-stale')
  writeFileSync(filePath, 'clean\n')
  writeFileSync(backupPath, 'clean\n')
  const lastCleanSync = snapshotForContent('clean\n')

  const first = checkpointProjectPartWriteback({
    filePath,
    content: 'first app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
  })
  assert.equal(first.ok, true)
  assert.equal(existsSync(backupPath), false)

  const currentClean = first.writeback.lastCleanSync
  unlinkSync(filePath)
  writeFileSync(backupPath, 'clean\n')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'second app edit\n',
    part: { metadata: { writeback: { lastCleanSync: currentClean } } },
    now: () => '2026-07-05T10:08:00.000Z',
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'deleted')
  assert.equal(result.writeback.status, 'deleted')
  assert.equal(existsSync(filePath), false)
  assert.equal(existsSync(backupPath), true)
})

test('checkpointProjectPartWriteback does not restore backup that misses clean baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'part-writeback-wrong-backup-'))
  const filePath = join(root, 'note.md')
  const backupPath = join(root, '.note.md.backup-wrong')
  writeFileSync(backupPath, 'wrong old content\n')
  const lastCleanSync = snapshotForContent('clean\n')

  const result = checkpointProjectPartWriteback({
    filePath,
    content: 'app edit\n',
    part: { metadata: { writeback: { lastCleanSync } } },
    now: () => '2026-07-05T10:09:00.000Z',
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'deleted')
  assert.equal(existsSync(filePath), false)
  assert.equal(readFileSync(backupPath, 'utf8'), 'wrong old content\n')
})

function legacyCheckpointForRaceRepro({ filePath, content, part = null, tempPathFactory, afterFinalCheck = null }) {
  const checkedAt = '2026-07-05T10:03:00.000Z'
  const lastCleanSync = part?.metadata?.writeback?.lastCleanSync || null
  const current = legacyReadFileSnapshot(filePath)
  if (lastCleanSync && current.hash !== lastCleanSync.hash && current.hash !== snapshotForContent(content).hash) {
    return { ok: false, status: 'conflict' }
  }

  if (!current.exists || current.content !== content) {
    const tmp = tempPathFactory(filePath)
    try {
      writeFileSync(tmp, content)
      legacyReadFileSnapshot(filePath)
      afterFinalCheck?.()
      renameSync(tmp, filePath)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
  }

  const synced = legacyReadFileSnapshot(filePath)
  return {
    ok: true,
    status: 'synced',
    writeback: {
      status: 'synced',
      syncedAt: checkedAt,
      lastCleanSync: {
        hash: synced.hash,
        size: synced.size,
        mtimeMs: synced.mtimeMs,
        syncedAt: checkedAt,
      },
    },
  }
}

function legacyReadFileSnapshot(filePath) {
  if (!existsSync(filePath)) return { exists: false }
  const content = readFileSync(filePath, 'utf8')
  const snapshot = snapshotForContent(content)
  return {
    exists: true,
    content,
    hash: snapshot.hash,
    size: snapshot.size,
    mtimeMs: 0,
  }
}
