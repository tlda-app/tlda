// P3: retraction matches what the task means. A task delegated to a
// not-yet-existing name is re-keyed the moment its row appears (creation
// hook), and the death-cleanup belt catches anything still verbatim-keyed by
// resolving each candidate key before comparing. A verbatim key that now
// resolves to a different live agent is not stolen.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-p3-'))
  const store = new FleetStore(join(dir, 'fleet.db'))
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function openTask(store, id) {
  return store.getTask(id)
}

test('creation hook re-keys a verbatim task to the new row', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertTask({ id: 'task-pre', agent: 'future-agent', description: 'd', delegated_by: 'fleet:owner' })
    assert.equal(openTask(store, 'task-pre').agent, 'future-agent')
    store.upsertAgent({ id: 'fleet:future', friendly_name: 'future-agent' })
    assert.equal(openTask(store, 'task-pre').agent, 'fleet:future')
  } finally { cleanup() }
})

test('death retires the re-keyed task (no orphan)', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertTask({ id: 'task-pre', agent: 'doomed', description: 'd', delegated_by: 'fleet:owner' })
    store.upsertAgent({ id: 'fleet:doomed', friendly_name: 'doomed', metadata: { shell: true } })
    store.markDead('fleet:doomed')
    const task = openTask(store, 'task-pre')
    assert.ok(['retired', 'done', 'retracted'].includes(task.status), `expected terminal status, got ${task.status}`)
  } finally { cleanup() }
})

test('belt catches a legacy verbatim task the hook never saw', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:legacy', friendly_name: 'legacy', metadata: { shell: true } })
    // Legacy state, as the air-pm pre-task sat: verbatim key on a row that
    // exists. Raw insert bypasses upsertTask's write-time normalize.
    store.db.prepare(`INSERT INTO tasks (id, agent, description, delegated_by, status) VALUES (?, ?, ?, ?, 'pending')`)
      .run('task-legacy', 'legacy', 'd', 'fleet:owner')
    const found = store.getActiveTasksForGoneAgent('fleet:legacy').map(t => t.id)
    assert.ok(found.includes('task-legacy'), 'the belt must match by meaning, not by column')
    store.markDead('fleet:legacy')
    const task = openTask(store, 'task-legacy')
    assert.ok(['retired', 'done', 'retracted'].includes(task.status), `expected terminal status, got ${task.status}`)
  } finally { cleanup() }
})

test('belt does not steal a verbatim key now held by another live agent', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:old', friendly_name: 'contested', metadata: { shell: true } })
    store.markDead('fleet:old')
    store.upsertAgent({ id: 'fleet:new', friendly_name: 'contested' })
    store.db.prepare(`INSERT INTO tasks (id, agent, description, delegated_by, status) VALUES (?, ?, ?, ?, 'pending')`)
      .run('task-live', 'contested', 'd', 'fleet:owner')
    const found = store.getActiveTasksForGoneAgent('fleet:old').map(t => t.id)
    assert.ok(!found.includes('task-live'), 'a key resolving to the live holder stays with it')
    assert.equal(openTask(store, 'task-live').status, 'pending')
  } finally { cleanup() }
})

test('creation hook ignores fleet:-keys and update upserts', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'alpha' })
    store.upsertTask({ id: 'task-id', agent: 'fleet:a', description: 'd', delegated_by: 'fleet:owner' })
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'alpha', last_seen: new Date().toISOString() })
    assert.equal(openTask(store, 'task-id').agent, 'fleet:a')
  } finally { cleanup() }
})
