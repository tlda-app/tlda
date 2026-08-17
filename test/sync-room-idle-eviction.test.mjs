// `rooms` was unbounded for the life of the process. An entry was removed only by
// replaceRoomSnapshot or closeAllRooms, so server RSS tracked every document ever
// *opened* rather than the ones in use. On 2026-08-17 that server sat at a ~1.9GB
// floor on a 3.9GB machine with no swap — 97% anonymous, with 5,914 projects on the
// box — and only a restart brought it down.
//
// Each resident document costs twice: the Yjs room, and `prevSnapshots`, which keeps
// a full copy of every record as the changelog diff baseline.
//
// What these tests are really defending is the claim that eviction loses nothing:
// the disk copy is current and reopening rebuilds the baseline. So the last test
// reopens an evicted document and reads its records back.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  initSyncRooms,
  closeAllRooms,
  getOrCreateRoom,
  listActiveRooms,
  evictIdleRooms,
  putShape,
  getRoomRecords,
} from '../server/lib/sync-rooms.mjs'

const DOC = 'doc-evictme'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-evict-'))
  // Sweep off: these tests drive evictIdleRooms directly rather than waiting.
  initSyncRooms(root, { evictIdleRooms: false })
  return root
}

async function seedDoc() {
  await getOrCreateRoom(DOC)
  await putShape(DOC, {
    id: 'shape:evict-test',
    typeName: 'shape',
    type: 'geo',
    x: 1,
    y: 2,
    rotation: 0,
    index: 'a1',
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    props: {},
    meta: {},
  })
}

test('an idle room is evicted and its snapshot survives on disk', async () => {
  const root = setup()
  try {
    await seedDoc()
    assert.ok(listActiveRooms().includes(DOC), 'room should be resident after open')

    const evicted = await evictIdleRooms({ idleMs: 0 })

    assert.deepEqual(evicted, [DOC], 'the idle room should be evicted')
    assert.ok(!listActiveRooms().includes(DOC), 'room should no longer be resident')
    assert.ok(
      existsSync(join(root, 'evictme', 'sync-snapshot.json')),
      'the document should have been flushed to disk before close',
    )
  } finally {
    closeAllRooms()
    rmSync(root, { recursive: true, force: true })
  }
})

// The counterfactual: without the idle threshold being met, nothing is evicted.
// This is what stops the sweep from closing rooms out from under live work.
test('a room inside the idle threshold is left alone', async () => {
  const root = setup()
  try {
    await seedDoc()

    const evicted = await evictIdleRooms({ idleMs: 10 * 60 * 1000 })

    assert.deepEqual(evicted, [], 'nothing should be evicted before the threshold')
    assert.ok(listActiveRooms().includes(DOC), 'room should still be resident')
  } finally {
    closeAllRooms()
    rmSync(root, { recursive: true, force: true })
  }
})

// The safety claim itself. Eviction is only acceptable because the document comes
// back intact — if this fails, eviction is data loss, not memory management.
test('an evicted document rehydrates with its records intact', async () => {
  const root = setup()
  try {
    await seedDoc()
    const before = await getRoomRecords(DOC, 'geo')
    assert.ok(before.some(r => r.id === 'shape:evict-test'), 'seeded shape should be present')

    await evictIdleRooms({ idleMs: 0 })
    assert.ok(!listActiveRooms().includes(DOC), 'precondition: room was evicted')

    // Reopens from disk and re-establishes the changelog baseline.
    const after = await getRoomRecords(DOC, 'geo')
    assert.ok(
      after.some(r => r.id === 'shape:evict-test'),
      'the shape must survive eviction and come back on reopen',
    )
    assert.ok(listActiveRooms().includes(DOC), 'reopening should make it resident again')
  } finally {
    closeAllRooms()
    rmSync(root, { recursive: true, force: true })
  }
})
