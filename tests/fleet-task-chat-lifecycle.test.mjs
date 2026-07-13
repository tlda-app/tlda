import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const serverSource = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')

function tempStore(prefix = 'fleet-task-chat-lifecycle') {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
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

function sourceBlock(marker, nextMarker) {
  const start = serverSource.indexOf(marker)
  assert.notEqual(start, -1, `missing source marker: ${marker}`)
  const end = nextMarker ? serverSource.indexOf(nextMarker, start + marker.length) : -1
  assert.notEqual(end, -1, `missing next marker after ${marker}: ${nextMarker}`)
  return serverSource.slice(start, end)
}

function assertOrder(source, labels) {
  let previous = -1
  for (const label of labels) {
    const at = source.indexOf(label)
    assert.notEqual(at, -1, `missing ordered source fragment: ${label}`)
    assert.ok(at > previous, `${label} should appear after the previous ordered fragment`)
    previous = at
  }
}

test('fleet WS chat temp-id retries return existing results before inserting duplicates', async () => {
  const chatBlock = sourceBlock("if (type === 'chat') {", "if (type === 'heartbeat') {")

  const memoryHitStart = chatBlock.indexOf('if (msg._tempId && _chatTempIds.has(msg._tempId))')
  assert.notEqual(memoryHitStart, -1)
  const dbHitStart = chatBlock.indexOf('if (msg._tempId) {', memoryHitStart + 1)
  assert.notEqual(dbHitStart, -1)
  const insertStart = chatBlock.indexOf('const inserted = await measureHotOp', dbHitStart)
  assert.notEqual(insertStart, -1)

  assertOrder(chatBlock.slice(memoryHitStart, dbHitStart), [
    'if (msg._tempId && _chatTempIds.has(msg._tempId))',
    "reply({ ok: true, event_ids: prev.eventIds, recipients: prev.recipients, receipts: prev.receipts || [], _tempId: msg._tempId, trace_id: traceId })",
    'return',
  ])
  assertOrder(chatBlock.slice(dbHitStart, insertStart), [
    'const prev = fleetStore.getChatTempIdResult?.(msg._tempId)',
    "reply({ ok: true, event_ids: prev.eventIds, recipients: prev.recipients, receipts: prev.receipts || [], _tempId: msg._tempId, trace_id: traceId })",
    'return',
  ])
  assertOrder(chatBlock.slice(insertStart), [
    'const inserted = await measureHotOp',
    'if (msg._tempId) _chatTempIds.set(msg._tempId',
    'reply({ ok: true, event_ids: eventIds, recipients, receipts, _tempId: msg._tempId || null, trace_id: traceId })',
    "broadcastEvent('fleet-event', broadcastEv)",
  ])

  const { store, dbPath } = tempStore('fleet-chat-tempid-lifecycle')
  try {
    const tempId = 'fleet:sender:mcp-chat:lifecycle-temp'
    const first = await store.chat('fleet:sender', 'fleet:recipient-a', 'hello', { client_temp_id: tempId })
    const second = await store.chat('fleet:sender', 'fleet:recipient-b', 'hello', { client_temp_id: tempId })

    const recovered = store.getChatTempIdResult(tempId)
    assert.deepEqual(recovered, {
      eventIds: [first.id, second.id],
      recipients: ['fleet:recipient-a', 'fleet:recipient-b'],
      receipts: [],
    })
    assert.equal(store.getUnreadCount('fleet:recipient-a'), 1)
    assert.equal(store.getUnreadCount('fleet:recipient-b'), 1)
  } finally {
    cleanup(store, dbPath)
  }
})

test('fleet WS delegate creates the task row and unread event before wake side effects', async () => {
  const delegateBlock = sourceBlock("if (type === 'delegate') {", "if (type === 'task-done') {")

  assertOrder(delegateBlock, [
    'fleetStore.upsertTask(task)',
    'const delegateEvent = await fleetStore.delegate',
    'await notificationAttempts.record',
    'broadcastState(resolved.id)',
    'reply({ ok: true, task_id: taskId, trace_id: traceId })',
    'requestWake(resolved.id, delegateWakeText(description, resolved.id), from, traceId)',
  ])
  assert.match(delegateBlock, /status: blocked_by\?\.length \? 'blocked' : 'pending'/)
  assert.match(delegateBlock, /pending_spawn_delegate: true/)

  const { store, dbPath } = tempStore('fleet-delegate-lifecycle')
  try {
    store.upsertAgent({ id: 'fleet:worker', friendly_name: 'worker', labels: [], dead: false })
    const task = {
      id: 'task-delegate-1',
      agent: 'fleet:worker',
      description: 'characterize lifecycle',
      message: 'body',
      delegated_by: 'fleet:mend',
      delegated_at: '2026-07-12T23:00:00.000Z',
      status: 'pending',
      acknowledged: false,
      success_criteria: ['cover delegate side effects'],
      metadata: { trace_id: 'delegate:test' },
    }
    store.upsertTask(task)
    const event = await store.delegate('fleet:mend', 'fleet:worker', task.id, task.description, {
      trace_id: 'delegate:test',
      criteria: task.success_criteria,
      message: task.message,
    })

    assert.equal(store.getTask(task.id).status, 'pending')
    assert.equal(store.getTask(task.id).delegated_by, 'fleet:mend')
    assert.deepEqual(store.getTask(task.id).success_criteria, ['cover delegate side effects'])
    assert.equal(event.type, 'delegate')
    assert.equal(event.task_id, task.id)
    assert.equal(store.getUnreadCount('fleet:worker'), 1)
    const delivery = store.getTaskDeliveryState(task.id)
    assert.equal(delivery.event.id, event.id)
    assert.equal(delivery.unreadPending, true)
    assert.equal(delivery.exposed, false)
  } finally {
    cleanup(store, dbPath)
  }
})

test('fleet WS report-close is operation-id idempotent and close marks task done once', async () => {
  const reportBlock = sourceBlock("if (type === 'report-close') {", "if (type === 'delete-task') {")

  assertOrder(reportBlock, [
    "if (!operation_id) { error('missing operation_id'); return }",
    'const previous = fleetStore.getReportCloseOperationResult?.(operation_id)',
    'let reportEventId = previous?.reportEventId || null',
    'if (!reportEventId) {',
    'if (!chatEventId && task.delegated_by) {',
    'if (close && !closeEventId) {',
    "task.status = 'done'",
    'fleetStore.upsertTask(task)',
    'const insertedClose = await fleetStore.taskDone',
    'broadcastState()',
    'reply({',
  ])
  assert.match(reportBlock, /task\.metadata = \{ \.\.\.\(task\.metadata \|\| \{\}\), close_reason: closeReason \}/)

  const { store, dbPath } = tempStore('fleet-report-close-lifecycle')
  try {
    const operationId = 'fleet:worker:mcp-report:task-report-1:close:test'
    store.upsertTask({
      id: 'task-report-1',
      agent: 'fleet:worker',
      description: 'finish lifecycle tests',
      message: 'finish lifecycle tests',
      delegated_by: 'fleet:mend',
      delegated_at: '2026-07-12T23:01:00.000Z',
      status: 'pending',
      metadata: { trace_id: 'report:test' },
    })

    const report = await store.report('fleet:worker', 'task-report-1', 'done', {
      client_operation_id: operationId,
      close_requested: true,
    })
    const chat = await store.chat('fleet:worker', 'fleet:mend', '**worker report: finish lifecycle tests**\n\ndone', {
      client_operation_id: operationId,
      type: 'report',
      report_event_id: report.id,
    })
    const task = store.getTask('task-report-1')
    task.status = 'done'
    task.completed_at = '2026-07-12T23:02:00.000Z'
    task.metadata = { ...(task.metadata || {}), close_reason: 'done' }
    store.upsertTask(task)
    const close = await store.taskDone('fleet:worker', 'task-report-1', 'finish lifecycle tests', {
      client_operation_id: operationId,
      report_event_id: report.id,
      close_reason: 'done',
    })

    const recovered = store.getReportCloseOperationResult(operationId)
    assert.deepEqual(recovered, {
      reportEventId: report.id,
      chatEventId: chat.id,
      closeEventId: close.id,
      taskId: 'task-report-1',
      eventIds: [report.id, chat.id, close.id],
    })
    const closed = store.getTask('task-report-1')
    assert.equal(closed.status, 'done')
    assert.equal(closed.metadata.close_reason, 'done')
    assert.equal(store.getActiveTaskCountByAgent('fleet:worker'), 0)
  } finally {
    cleanup(store, dbPath)
  }
})

test('fleet WS my-task exposes active tasks and unread without consuming peeked messages', async () => {
  const myTaskBlock = sourceBlock("if (type === 'my-task') {", "if (type === 'inbox-status') {")

  assertOrder(myTaskBlock, [
    'fleetStore.updateHeartbeat(agentId)',
    'const tasks = fleetStore.getActiveTasksByAgentLimited',
    'const unread = fleetStore.getUnreadLimited',
    'if (unread.length && !msg.peek) {',
    'const readIds = fleetStore.markEventsRead?.(agentId, unread.map(m => m.id)) || []',
    "broadcastEvent('read-receipt', { event_ids: readIds, agent: agentId })",
    'broadcastState()',
    'reply({',
  ])
  assert.match(myTaskBlock, /tasks_truncated: taskCount > tasks\.length/)
  assert.match(myTaskBlock, /messages_truncated: unreadCount > unread\.length/)

  const { store, dbPath } = tempStore('fleet-my-task-lifecycle')
  try {
    for (let i = 0; i < 2; i++) {
      store.upsertTask({
        id: `task-visible-${i}`,
        agent: 'fleet:worker',
        description: `visible task ${i}`,
        delegated_at: `2026-07-12T23:0${i}:00.000Z`,
        status: 'pending',
      })
    }
    const first = await store.chat('fleet:mend', 'fleet:worker', 'first unread')
    const second = await store.chat('fleet:mend', 'fleet:worker', 'second unread')

    const tasks = store.getActiveTasksByAgentLimited('fleet:worker', 20)
    const unreadPeek = store.getUnreadLimited('fleet:worker', 50)
    assert.deepEqual(tasks.map(task => task.id), ['task-visible-1', 'task-visible-0'])
    assert.deepEqual(unreadPeek.map(event => event.id), [first.id, second.id])
    assert.equal(store.getUnreadCount('fleet:worker'), 2, 'peek-style read should not mark unread rows')

    const readIds = store.markEventsRead('fleet:worker', unreadPeek.map(event => event.id))
    assert.deepEqual(readIds, [first.id, second.id])
    assert.equal(store.getUnreadCount('fleet:worker'), 0)
  } finally {
    cleanup(store, dbPath)
  }
})
