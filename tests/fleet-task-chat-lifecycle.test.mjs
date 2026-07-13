import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { canReportTask, completeTaskLifecycle } from '../server/lib/task-lifecycle.mjs'

const serverSource = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const fleetRouteSource = fs.readFileSync(new URL('../server/routes/fleet.mjs', import.meta.url), 'utf8')
const mcpSource = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')

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
  return sourceBlockFrom(serverSource, marker, nextMarker)
}

function sourceBlockFrom(source, marker, nextMarker) {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing source marker: ${marker}`)
  const end = nextMarker ? source.indexOf(nextMarker, start + marker.length) : -1
  assert.notEqual(end, -1, `missing next marker after ${marker}: ${nextMarker}`)
  return source.slice(start, end)
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
    'const previous = operation_id ? fleetStore.getDelegateOperationResult',
    'fleetStore.upsertTask(task)',
    'const delegateEvent = await fleetStore.delegate',
    'await notificationAttempts.record',
    'broadcastState(resolved.id)',
    'delegate_event_id: delegateEvent?.id || null',
    'requestWake(resolved.id, delegateWakeText(description, resolved.id), from, traceId)',
  ])
  assert.match(delegateBlock, /status: blocked_by\?\.length \? 'blocked' : 'pending'/)
  assert.match(delegateBlock, /pending_spawn_delegate: true/)
  assert.match(delegateBlock, /client_operation_id: operation_id/)

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
      client_operation_id: 'delegate:operation:test',
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
    const recovered = store.getDelegateOperationResult('delegate:operation:test')
    assert.deepEqual(recovered, {
      delegateEventId: event.id,
      taskId: task.id,
      eventIds: [event.id],
    })
  } finally {
    cleanup(store, dbPath)
  }
})

test('fleet WS delegate recovers duplicate operation ids before creating a second task', () => {
  const delegateBlock = sourceBlock("if (type === 'delegate') {", "if (type === 'task-done') {")

  assertOrder(delegateBlock, [
    'const previous = operation_id ? fleetStore.getDelegateOperationResult',
    'if (previous?.delegateEventId) {',
    'idempotent: true',
    'const taskId = previous?.taskId || `${resolved.id.slice(0, 10)}-${Date.now().toString(36)}`',
  ])
  assertOrder(delegateBlock, [
    'client_operation_id: operation_id',
    'fleetStore.upsertTask(task)',
    'const delegateEvent = await fleetStore.delegate',
    'requestWake(resolved.id, delegateWakeText(description, resolved.id), from, traceId)',
  ])
  const normalReply = delegateBlock.slice(delegateBlock.indexOf('delegate_event_id: delegateEvent?.id || null'))
  assertOrder(normalReply, [
    'delegate_event_id: delegateEvent?.id || null',
    'event_ids: [delegateEvent?.id].filter(id => id != null)',
    'operation_id: operation_id || null',
    'trace_id: traceId',
  ])
})

test('MCP delegate uses durable fleet transport with an operation id', () => {
  const mcpDelegateBlock = sourceBlockFrom(mcpSource, "if (name === 'delegate') {", '  // ==== Messaging ====')

  assert.ok(mcpSource.includes("operation_id: { type: 'string', description: 'Optional stable idempotency key for retrying the same delegate operation.' }"))
  assertOrder(mcpDelegateBlock, [
    'const operationId = args.operation_id',
    'operation_id: operationId',
    "const data = await sendDurableFleet('delegate', delegateBody, { operationId })",
    'rememberOriginatedEvents(data)',
  ])
  assert.equal(mcpDelegateBlock.includes("await sendWS('delegate', delegateBody)"), false)
})

test('fleet WS report-close is operation-id idempotent and close marks task done once', async () => {
  const reportBlock = sourceBlock("if (type === 'report-close') {", "if (type === 'delete-task') {")

  assertOrder(reportBlock, [
    "if (!operation_id) { error('missing operation_id'); return }",
    'const closeDecision = close ? decideReportClose(summary) : { allowClose: true }',
    'const previous = fleetStore.getReportCloseOperationResult?.(operation_id)',
    'let reportEventId = previous?.reportEventId || null',
    'if (!reportEventId) {',
    'if (!chatEventId && task.delegated_by) {',
    'if (close && closeDecision.allowClose && !closeEventId) {',
    'const { eventId } = await completeTaskLifecycle({',
    'taskMetadataPatch: { close_reason: closeReason, closed_by: agent }',
    'eventMetadata: {',
    'closeEventId = eventId || null',
    'broadcastState()',
    'reply({',
  ])
  assert.match(reportBlock, /task_description: task\.description/)

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

test('task completion lifecycle helper marks done and emits the task_done event once', async () => {
  const { store, dbPath } = tempStore('task-completion-lifecycle-helper')
  try {
    store.upsertTask({
      id: 'task-complete-1',
      agent: 'fleet:worker',
      description: 'complete lifecycle helper',
      message: 'complete lifecycle helper',
      delegated_by: 'fleet:mend',
      delegated_at: '2026-07-12T23:02:00.000Z',
      status: 'pending',
      metadata: { trace_id: 'complete:test' },
    })

    const original = store.getTask('task-complete-1')
    const result = await completeTaskLifecycle({
      fleetStore: store,
      agentId: 'fleet:worker',
      task: original,
      completedAt: '2026-07-12T23:03:00.000Z',
      eventMetadata: { trace_id: 'complete:test', source: 'unit' },
    })

    assert.equal(result.event.type, 'task_done')
    assert.equal(result.event.task_id, 'task-complete-1')
    assert.equal(result.event.metadata.trace_id, 'complete:test')
    const completed = store.getTask('task-complete-1')
    assert.equal(completed.status, 'done')
    assert.equal(completed.completed_at, '2026-07-12T23:03:00.000Z')
    assert.deepEqual(completed.metadata, { trace_id: 'complete:test' })
    assert.equal(store.getActiveTaskCountByAgent('fleet:worker'), 0)
  } finally {
    cleanup(store, dbPath)
  }
})

test('target-task report authority allows assignee, delegator, or human', () => {
  const { store, dbPath } = tempStore('target-task-lifecycle')
  try {
    const manager = { id: 'fleet:manager', friendly_name: 'manager', human: false }
    const worker = { id: 'fleet:worker', friendly_name: 'worker', human: false }
    const stranger = { id: 'fleet:stranger', friendly_name: 'stranger', human: false }
    const human = { id: 'fleet:skip', friendly_name: 'skip', human: true }
    store.upsertAgent(manager)
    store.upsertAgent(worker)
    store.upsertAgent(stranger)
    store.upsertAgent(human)
    store.upsertTask({
      id: 'task-target-report-1', agent: worker.id, description: 'stale work',
      delegated_by: manager.id, delegated_at: '2026-07-13T10:00:00.000Z', status: 'pending',
    })
    const task = store.getTask('task-target-report-1')
    assert.equal(canReportTask({ caller: worker, task }), true)
    assert.equal(canReportTask({ caller: manager, task }), true)
    assert.equal(canReportTask({ caller: human, task }), true)
    assert.equal(canReportTask({ caller: stranger, task }), false)
  } finally {
    cleanup(store, dbPath)
  }
})

test('report accepts task_id and server authorizes target task reporting', () => {
  const serverReportBlock = sourceBlock("if (type === 'report-close') {", "if (type === 'delete-task') {")
  assertOrder(serverReportBlock, [
    'const caller = fleetStore.findAgent?.(rawAgent)',
    'const task = task_id',
    'if (task_id && !canReportTask({ caller: caller || { id: agent }, task }))',
    'const closeDecision = close ? decideReportClose(summary)',
    'const previous = fleetStore.getReportCloseOperationResult?.(operation_id)',
    'await completeTaskLifecycle({',
    'task_description: task.description',
  ])
  assert.match(serverReportBlock, /only its assignee, delegator, or a human may do so/)
  assert.equal(serverSource.includes("if (type === 'close-target-task') {"), false)

  const reportSchemaStart = mcpSource.indexOf("name: 'report'")
  const reportSchemaEnd = mcpSource.indexOf("];\n}", reportSchemaStart)
  const reportSchema = mcpSource.slice(reportSchemaStart, reportSchemaEnd)
  assert.match(reportSchema, /task_id: \{ type: 'string'/)
  assert.equal(mcpSource.includes("name: 'close_target_task'"), false)

  const mcpReportBlock = sourceBlockFrom(mcpSource, "if (name === 'report') {", '// ---- read_terminal')
  assertOrder(mcpReportBlock, [
    'const targetTaskId = typeof args.task_id',
    'const reportTaskId = targetTaskId || task.id',
    "sendDurableFleet('report-close'",
    'task_id: reportTaskId',
  ])
  assert.equal(mcpReportBlock.includes("sendDurableFleet('close-target-task'"), false)
})

test('task-done callers route their final completion transition through the lifecycle helper', () => {
  const wsTaskDoneBlock = sourceBlock("if (type === 'task-done') {", "if (type === 'report-close') {")
  assertOrder(wsTaskDoneBlock, [
    "if (task.metadata?.requires_approval)",
    'const { eventId } = await completeTaskLifecycle({ fleetStore, agentId: agent, task })',
    'broadcastState()',
    'reply({ ok: true, task_id: task.id, event_id: eventId })',
  ])
  assert.equal(wsTaskDoneBlock.includes("task.status = 'done'"), false)
  assert.equal(wsTaskDoneBlock.includes('fleetStore.upsertTask(task)'), false)
  assert.equal(wsTaskDoneBlock.includes('fleetStore.taskDone?.(agent'), false)

  const restDoneBlock = sourceBlockFrom(fleetRouteSource, "router.post('/api/tasks/done'", "  // --- POST /api/tasks/delete ---")
  assertOrder(restDoneBlock, [
    "if (!skip_qa && fleetStore)",
    'await completeTaskLifecycle({ fleetStore, agentId: agent, task })',
    'broadcastState()',
    'res.json({ ok: true, task_id: task.id })',
  ])
  assert.equal(restDoneBlock.includes("task.status = 'done'"), false)
  assert.equal(restDoneBlock.includes('fleetStore.upsertTask(task)'), false)
  assert.equal(restDoneBlock.includes('fleetStore.taskDone?.(agent'), false)
})

test('report close does not hard-block on success criteria but still requires approval gates', async () => {
  const mcpReportBlock = sourceBlockFrom(mcpSource, "if (name === 'report') {", '// --- First call: gather diff and return review prompt ---')
  assert.equal(mcpReportBlock.includes('task.success_criteria?.length && !args.verified'), false)
  assert.equal(mcpReportBlock.includes('success criteria you must verify before closing'), false)
  assertOrder(mcpReportBlock, [
    'const closeRequested = args.close === true || args.pass === true',
    'if (closeRequested && !targetTaskId && task.metadata?.requires_approval && !args.approval_id)',
    'sendDurableFleet',
    'reason: args.reason || undefined',
  ])

  const serverReportBlock = sourceBlock("if (type === 'report-close') {", "if (type === 'delete-task') {")
  assertOrder(serverReportBlock, [
    "const closeReason = reason || 'done'",
    'const { eventId } = await completeTaskLifecycle({',
    'taskMetadataPatch: { close_reason: closeReason, closed_by: agent }',
    'close_reason: closeReason',
  ])

  const { store, dbPath } = tempStore('fleet-canceled-close-lifecycle')
  try {
    const operationId = 'fleet:worker:mcp-report:task-canceled-1:close:test'
    store.upsertTask({
      id: 'task-canceled-1',
      agent: 'fleet:worker',
      description: 'canceled audit',
      message: 'canceled audit',
      delegated_by: 'fleet:mend',
      delegated_at: '2026-07-12T23:03:00.000Z',
      status: 'pending',
      success_criteria: ['audit subscription routes'],
    })

    const report = await store.report('fleet:worker', 'task-canceled-1', 'normal close report without verified flag', {
      client_operation_id: operationId,
      close_requested: true,
    })
    const task = store.getTask('task-canceled-1')
    const closeReason = 'canceled'
    task.status = 'done'
    task.completed_at = '2026-07-12T23:04:00.000Z'
    task.metadata = { ...(task.metadata || {}), close_reason: closeReason }
    store.upsertTask(task)
    const close = await store.taskDone('fleet:worker', 'task-canceled-1', 'canceled audit', {
      client_operation_id: operationId,
      report_event_id: report.id,
      close_reason: closeReason,
    })

    const closed = store.getTask('task-canceled-1')
    assert.equal(closed.status, 'done')
    assert.deepEqual(closed.success_criteria, ['audit subscription routes'])
    assert.equal(closed.metadata.close_reason, 'canceled')
    assert.equal(store.getActiveTaskCountByAgent('fleet:worker'), 0)
    const recovered = store.getReportCloseOperationResult(operationId)
    assert.equal(recovered.reportEventId, report.id)
    assert.equal(recovered.closeEventId, close.id)
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
