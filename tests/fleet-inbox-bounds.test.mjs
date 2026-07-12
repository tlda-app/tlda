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

test('active task and session startup queries use boot-path indexes', () => {
  const { store, dbPath } = tempStore()
  try {
    const activeTasksPlan = store.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM tasks
      WHERE status NOT IN ('done', 'retracted')
      ORDER BY delegated_at DESC
    `).all().map(row => row.detail).join('\n')
    assert.match(activeTasksPlan, /idx_tasks_active_live/)
    assert.doesNotMatch(activeTasksPlan, /USE TEMP B-TREE/)

    const agentTasksPlan = store.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM tasks
      WHERE agent = ? AND status NOT IN ('done', 'retracted')
      ORDER BY delegated_at DESC
      LIMIT ?
    `).all('fleet:recipient', 20).map(row => row.detail).join('\n')
    assert.match(agentTasksPlan, /idx_tasks_agent_active_live/)
    assert.doesNotMatch(agentTasksPlan, /USE TEMP B-TREE/)

    const sessionPlan = store.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT DISTINCT session_id FROM session_entries
    `).all().map(row => row.detail).join('\n')
    assert.match(sessionPlan, /idx_session_entries_session/)
    assert.doesNotMatch(sessionPlan, /USE TEMP B-TREE/)

    const prettyNameBackfillPlan = store.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, friendly_name FROM agents
      WHERE friendly_name IS NOT NULL
        AND friendly_name != ''
        AND (pretty_name IS NULL OR pretty_name = '')
    `).all().map(row => row.detail).join('\n')
    assert.match(prettyNameBackfillPlan, /idx_agents_missing_pretty_name/)
    assert.doesNotMatch(prettyNameBackfillPlan, /SCAN agents/)
  } finally {
    cleanup(store, dbPath)
  }
})
