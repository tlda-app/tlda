import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __testSyncChangelog, initSyncRooms } from '../server/lib/sync-rooms.mjs'

class FakeStorage {
  constructor(records) {
    this.clock = 0
    this.documents = new Map(records.map((state) => [state.id, { state, lastChangedClock: 0 }]))
    this.tombstones = new Map()
  }

  getClock() {
    return this.clock
  }

  transaction(callback) {
    const result = callback({
      getChangesSince: (sinceClock) => {
        if (sinceClock === this.clock) return undefined
        const diff = { puts: {}, deletes: [] }
        for (const [id, doc] of this.documents) {
          if (doc.lastChangedClock > sinceClock) diff.puts[id] = doc.state
        }
        for (const [id, clock] of this.tombstones) {
          if (clock > sinceClock) diff.deletes.push(id)
        }
        return { diff, wipeAll: false }
      },
    })
    return { documentClock: this.clock, didChange: false, result }
  }

  applyBatch(ops) {
    if (ops.length === 0) return
    this.clock += 1
    for (const op of ops) {
      if (op.kind === 'put') {
        this.documents.set(op.record.id, { state: op.record, lastChangedClock: this.clock })
        this.tombstones.delete(op.record.id)
      } else {
        this.documents.delete(op.id)
        this.tombstones.set(op.id, this.clock)
      }
    }
  }

  getSnapshot() {
    return {
      documentClock: this.clock,
      documents: [...this.documents.values()],
      tombstones: Object.fromEntries(this.tombstones),
    }
  }
}

class FakeRoom {
  constructor(records) {
    this.storage = new FakeStorage(records)
  }

  getCurrentSnapshot() {
    return this.storage.getSnapshot()
  }
}

function buildDocMap(docs) {
  return new Map(docs.map((doc) => [doc.state.id, { state: doc.state, clock: doc.lastChangedClock }]))
}

function shallowDiff(a, b) {
  const diff = {}
  let changed = false
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[key]
    const bv = b[key]
    if (av === bv) continue
    if (typeof av === 'object' && typeof bv === 'object' && av !== null && bv !== null) {
      if (JSON.stringify(av) === JSON.stringify(bv)) continue
    }
    diff[key] = { from: av, to: bv }
    changed = true
  }
  return changed ? diff : null
}

function oldWholeDocDiff(prev, snapshot) {
  const current = buildDocMap(snapshot.documents)
  const entries = []
  for (const [id, { state, clock }] of current) {
    const old = prev.get(id)
    if (!old) {
      entries.push({ ts: 1, action: 'create', id, type: state.typeName, shapeType: state.type, state })
    } else if (old.clock !== clock) {
      const diff = shallowDiff(old.state, state)
      if (diff) entries.push({ ts: 1, action: 'update', id, type: state.typeName, shapeType: state.type, diff })
    }
  }
  for (const [id, { state }] of prev) {
    if (!current.has(id)) {
      entries.push({ ts: 1, action: 'delete', id, type: state.typeName, shapeType: state.type })
    }
  }
  return {
    prev: current,
    interesting: entries.filter((entry) => entry.type === 'shape' || entry.action === 'delete'),
  }
}

function normalize(changes) {
  return (changes ?? []).map((change) => ({ ...change, ts: 1 }))
}

test('delta-driven changelog output matches old whole-document diff output', async () => {
  const projectsDir = await mkdtemp(join(tmpdir(), 'tlda-sync-changelog-'))
  await mkdir(join(projectsDir, 'equiv'), { recursive: true })
  initSyncRooms(projectsDir)
  __testSyncChangelog.reset()

  const initialRecords = [
    { id: 'document:document', typeName: 'document', name: 'Document' },
    { id: 'page:page', typeName: 'page', name: 'Page' },
    { id: 'shape:one', typeName: 'shape', type: 'math-note', props: { x: 1 }, meta: { color: 'blue' } },
    { id: 'camera:main', typeName: 'camera', x: 0, y: 0 },
  ]
  const room = new FakeRoom(initialRecords)
  const docName = 'doc-equiv'
  __testSyncChangelog.setChangelogBaseline(docName, room.getCurrentSnapshot())

  let oldPrev = buildDocMap(room.getCurrentSnapshot().documents)
  const batches = [
    [
      { kind: 'put', record: { id: 'shape:one', typeName: 'shape', type: 'math-note', props: { x: 2 }, meta: { color: 'blue' } } },
      { kind: 'put', record: { id: 'camera:main', typeName: 'camera', x: 10, y: 0 } },
    ],
    [
      { kind: 'put', record: { id: 'shape:two', typeName: 'shape', type: 'highlight', props: { color: 'yellow' }, meta: {} } },
      { kind: 'put', record: { id: 'page:extra', typeName: 'page', name: 'Extra' } },
    ],
    [
      { kind: 'delete', id: 'shape:one' },
      { kind: 'delete', id: 'page:extra' },
    ],
    [
      { kind: 'put', record: { id: 'shape:two', typeName: 'shape', type: 'highlight', props: { color: 'green' }, meta: { reviewed: true } } },
    ],
    [
      { kind: 'put', record: { id: 'shape:temp', typeName: 'shape', type: 'geo', props: { w: 10 }, meta: {} } },
      { kind: 'delete', id: 'shape:temp' },
    ],
  ]

  try {
    for (const batch of batches) {
      room.storage.applyBatch(batch)
      const expected = oldWholeDocDiff(oldPrev, room.getCurrentSnapshot())
      oldPrev = expected.prev

      const actual = __testSyncChangelog.recordChanges(docName, room)
      assert.deepEqual(normalize(actual), expected.interesting)
    }
  } finally {
    __testSyncChangelog.reset()
    await rm(projectsDir, { recursive: true, force: true })
  }
})
