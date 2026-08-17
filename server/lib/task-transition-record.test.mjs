// `tasks` is the record, not a cache — nothing rebuilds it from events — and
// `upsertTask` writes the row and no event. So the transitions that do not run
// through the delegate/report paths left no trace: an agent's death retiring its
// open tasks, a retract after delivery, and an owner change on successor handoff.
// "Who closed this, and why" was unanswerable, and a task blocked for six hours
// then closed looked identical to one closed immediately.
//
// These assert on the events table directly, because the point is that a record
// EXISTS after the transition — not that some reader renders it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-task-transition-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  return { store, dir }
}

function taskUpdates(store, taskId) {
  return store.db.prepare(
    "SELECT text, metadata FROM events WHERE type = 'task_update' AND task_id = ? ORDER BY id",
  ).all(taskId).map(row => ({ text: row.text, metadata: JSON.parse(row.metadata || '{}') }))
}

test('retiring a task records the transition and its reason', async () => {
  const { store, dir } = freshStore()
  try {
    await store.upsertAgent({ id: 'fleet:worker', friendly_name: 'retire-worker', dead: false })
    store.upsertTask({ id: 'task-retire', agent: 'fleet:worker', description: 'do a thing', status: 'pending' })

    assert.equal(taskUpdates(store, 'task-retire').length, 0, 'no transition recorded yet')

    store.retireTask('task-retire', { reason: 'agent marked dead — task closed with its agent', retiredBy: 'system' })

    const events = taskUpdates(store, 'task-retire')
    assert.equal(events.length, 1, 'exactly one transition recorded')
    assert.equal(events[0].metadata.status, 'retracted')
    // The reason is the whole value of the record: it is the only place the why
    // exists, and retireTask refuses to run without one.
    assert.match(events[0].metadata.reason, /task closed with its agent/)
    assert.equal(events[0].metadata.retired_by, 'system')
    assert.match(events[0].text, /status → retracted/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an agent death retires its open tasks with a record for each', async () => {
  const { store, dir } = freshStore()
  try {
    await store.upsertAgent({ id: 'fleet:doomed', friendly_name: 'doomed-worker', dead: false })
    store.upsertTask({ id: 'task-a', agent: 'fleet:doomed', description: 'first', status: 'pending' })
    store.upsertTask({ id: 'task-b', agent: 'fleet:doomed', description: 'second', status: 'working' })

    // The real path: this is what runs when an agent is marked dead.
    store.retireTasksForGoneAgent('fleet:doomed', 'agent marked dead')

    for (const taskId of ['task-a', 'task-b']) {
      const events = taskUpdates(store, taskId)
      assert.equal(events.length, 1, `${taskId} recorded its retirement`)
      assert.match(events[0].metadata.reason, /agent marked dead/)
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transferring task ownership records the previous owner', async () => {
  const { store, dir } = freshStore()
  try {
    await store.upsertAgent({ id: 'fleet:old', friendly_name: 'old-seat', dead: false })
    await store.upsertAgent({ id: 'fleet:new', friendly_name: 'new-seat', dead: false })
    store.upsertTask({ id: 'task-moved', agent: 'fleet:old', description: 'carried over', status: 'working' })
    store.upsertTask({ id: 'task-finished', agent: 'fleet:old', description: 'already done', status: 'done' })

    const moved = store.transferTasks('fleet:old', 'fleet:new')
    assert.equal(moved, 1, 'only the open task moves')

    const events = taskUpdates(store, 'task-moved')
    assert.equal(events.length, 1, 'the transfer is recorded')
    // Recoverable only because it is captured before the UPDATE; afterwards the
    // row is indistinguishable from one the successor always owned.
    assert.equal(events[0].metadata.previous_agent, 'fleet:old')
    assert.equal(events[0].metadata.new_agent, 'fleet:new')

    assert.equal(taskUpdates(store, 'task-finished').length, 0, 'a done task is not transferred or recorded')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tasks table is the record: no rebuild exists', async () => {
  const { store, dir } = freshStore()
  try {
    // Guards the DDL comment against drifting back to "cache, rebuilt from
    // events". If a rebuild is ever added, this test should be deleted in the
    // commit that adds it — that is the point of asserting it.
    const rebuilders = Object.getOwnPropertyNames(Object.getPrototypeOf(store))
      .filter(name => /^rebuild.*[Tt]ask/.test(name))
    assert.deepEqual(rebuilders, [], 'no task rebuild-from-events path exists')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
