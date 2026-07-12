import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempStore() {
  const dbPath = path.join(os.tmpdir(), `fleet-inbox-bounds-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort temp cleanup */ }
  }
  return { store: new FleetStore(dbPath), dbPath }
}

function cleanup(store, dbPath) {
  store.close()
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort temp cleanup */ }
  }
}

test('bounded inbox reads mark only the returned unread page', async () => {
  const { store, dbPath } = tempStore()
  try {
    for (let i = 0; i < 5; i++) {
      await store.share({
        type: 'chat',
        from: 'fleet:sender',
        to: 'fleet:recipient',
        text: `message ${i}`,
        timestamp: `2026-07-12T00:00:0${i}.000Z`,
      })
    }

    const page = store.getUnreadLimited('fleet:recipient', 2)
    assert.deepEqual(page.map(e => e.text), ['message 0', 'message 1'])
    assert.equal(store.getUnreadCount('fleet:recipient'), 5)

    const marked = store.markEventsRead('fleet:recipient', page.map(e => e.id))
    assert.deepEqual(marked, page.map(e => e.id))
    assert.equal(store.getUnreadCount('fleet:recipient'), 3)
    assert.deepEqual(store.getUnread('fleet:recipient').map(e => e.text), ['message 2', 'message 3', 'message 4'])
  } finally {
    cleanup(store, dbPath)
  }
})

test('active task reads can be counted separately from their page', () => {
  const { store, dbPath } = tempStore()
  try {
    for (let i = 0; i < 3; i++) {
      store.upsertTask({
        id: `task-${i}`,
        agent: 'fleet:recipient',
        description: `task ${i}`,
        message: `task body ${i}`,
        delegated_by: 'fleet:sender',
        delegated_at: `2026-07-12T00:00:0${i}.000Z`,
        status: 'pending',
      })
    }

    const page = store.getActiveTasksByAgentLimited('fleet:recipient', 2)
    assert.equal(page.length, 2)
    assert.equal(store.getActiveTaskCountByAgent('fleet:recipient'), 3)
  } finally {
    cleanup(store, dbPath)
  }
})

test('active task pages are bounded and cursor-indexed', () => {
  const { store, dbPath } = tempStore()
  try {
    for (let i = 0; i < 3; i++) {
      store.upsertTask({
        id: `task-${i}`,
        agent: 'fleet:recipient',
        description: `task ${i}`,
        message: `task body ${i}`,
        delegated_by: 'fleet:sender',
        delegated_at: `2026-07-12T00:00:0${i}.000Z`,
        status: 'pending',
      })
    }
    store.upsertTask({
      id: 'task-done',
      agent: 'fleet:recipient',
      description: 'done task',
      delegated_at: '2026-07-12T00:00:03.000Z',
      status: 'done',
      completed_at: '2026-07-12T00:00:04.000Z',
    })

    const first = store.getActiveTasksPage({ limit: 2 })
    assert.deepEqual(first.tasks.map(t => t.id), ['task-2', 'task-1'])
    assert.ok(first.nextCursor)

    const second = store.getActiveTasksPage({ limit: 2, cursor: first.nextCursor })
    assert.deepEqual(second.tasks.map(t => t.id), ['task-0'])
    assert.equal(second.nextCursor, null)
  } finally {
    cleanup(store, dbPath)
  }
})

test('task changes are consumed as deltas for live broadcasts', () => {
  const { store, dbPath } = tempStore()
  try {
    store.consumeTaskChanges()
    store.upsertTask({
      id: 'task-1',
      agent: 'fleet:recipient',
      description: 'task 1',
      delegated_at: '2026-07-12T00:00:00.000Z',
      status: 'pending',
    })
    let delta = store.consumeTaskChanges()
    assert.deepEqual(delta.changed.map(t => t.id), ['task-1'])
    assert.deepEqual(delta.removed, [])
    assert.equal(delta.overflow, false)

    store.removeTask('task-1')
    delta = store.consumeTaskChanges()
    assert.deepEqual(delta.changed, [])
    assert.deepEqual(delta.removed, ['task-1'])
    assert.equal(delta.overflow, false)

    assert.deepEqual(store.consumeTaskChanges(), { changed: [], removed: [], overflow: false })
  } finally {
    cleanup(store, dbPath)
  }
})
