import test from 'node:test'
import assert from 'node:assert/strict'

import { ServerTimerScheduler } from '../server/lib/timer-scheduler.mjs'

function timerStore(event, task = null) {
  return {
    event,
    getEventById(id) {
      return Number(id) === Number(this.event.id) ? structuredClone(this.event) : null
    },
    getTask(id) {
      return task?.id === id ? task : null
    },
    claimTimerTerminal(id, { metadataPatch }) {
      if (!this.event.metadata.pending) return false
      this.event.metadata = { ...this.event.metadata, ...metadataPatch }
      return true
    },
    updateEventMetadata(id, patch) {
      this.event.metadata = { ...this.event.metadata, ...patch }
    },
    listPendingTimerEvents() {
      return this.event.metadata.pending ? [structuredClone(this.event)] : []
    },
  }
}

test('recurring task timer reschedules the same durable event while task is open', () => {
  const now = Date.parse('2026-07-28T10:00:00.000Z')
  const event = {
    id: 41,
    type: 'timer',
    from: 'fleet:manager',
    to: 'fleet:worker',
    text: '⏱ check task',
    metadata: {
      pending: true,
      fire_at: new Date(now).toISOString(),
      repeat_seconds: 300,
      task_id: 'task-1',
      expires_at: new Date(now + 3_600_000).toISOString(),
    },
  }
  const store = timerStore(event, { id: 'task-1', status: 'working' })
  const broadcasts = []
  const scheduler = new ServerTimerScheduler({
    store,
    broadcast: (type, data) => broadcasts.push({ type, data }),
    now: () => now,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn() {},
  })

  const result = scheduler.fire(41)

  assert.equal(result.recurring, true)
  assert.equal(store.event.metadata.pending, true)
  assert.equal(store.event.metadata.fire_at, '2026-07-28T10:05:00.000Z')
  assert.equal(broadcasts[0].data.metadata.state, 'fired')
  assert.equal(broadcasts[1].data.metadata.state, 'pending')
})

test('recurring task timer cancels instead of notifying after task closes', () => {
  const now = Date.parse('2026-07-28T10:00:00.000Z')
  const event = {
    id: 42,
    type: 'timer',
    from: 'fleet:manager',
    to: 'fleet:worker',
    text: '⏱ check task',
    metadata: {
      pending: true,
      fire_at: new Date(now).toISOString(),
      repeat_seconds: 300,
      task_id: 'task-2',
    },
  }
  const store = timerStore(event, { id: 'task-2', status: 'done' })
  const scheduler = new ServerTimerScheduler({
    store,
    now: () => now,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn() {},
  })

  const result = scheduler.fire(42)

  assert.equal(result.notified, false)
  assert.equal(store.event.metadata.pending, false)
  assert.equal(store.event.metadata.state, 'cancelled')
})

test('task expiry retracts the task without notifying', () => {
  const now = Date.parse('2026-07-28T10:00:00.000Z')
  const event = {
    id: 43,
    type: 'timer',
    from: 'fleet:manager',
    to: 'fleet:worker',
    text: 'Task expired',
    metadata: {
      pending: true,
      fire_at: new Date(now).toISOString(),
      task_id: 'task-3',
      task_expiry: true,
    },
  }
  const store = timerStore(event, { id: 'task-3', status: 'pending' })
  let retracted = null
  store.retractTask = (taskId, options) => { retracted = { taskId, options } }
  const scheduler = new ServerTimerScheduler({
    store,
    broadcast: () => {},
    now: () => now,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn() {},
  })

  const result = scheduler.fire(43)

  assert.equal(result.notified, false)
  assert.deepEqual(retracted, { taskId: 'task-3', options: { retractedBy: 'timer' } })
  assert.equal(store.event.metadata.state, 'cancelled')
})
