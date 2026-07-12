import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempStore() {
  const dbPath = path.join(os.tmpdir(), `report-close-operation-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort cleanup */ }
  }
  return { store: new FleetStore(dbPath), dbPath }
}

function cleanup(store, dbPath) {
  store.close()
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort cleanup */ }
  }
}

test('report-close operation result is recoverable from persisted event metadata', async () => {
  const { store, dbPath } = tempStore()
  try {
    const operationId = 'fleet:agent:mcp-report:task-1:close:abc123'
    const report = await store.report('fleet:agent', 'task-1', 'finished the work', {
      client_operation_id: operationId,
      close_requested: true,
    })
    const chat = await store.chat('fleet:agent', 'fleet:owner', 'report body', {
      client_operation_id: operationId,
      type: 'report',
      report_event_id: report.id,
    })
    const close = await store.taskDone('fleet:agent', 'task-1', 'do the work', {
      client_operation_id: operationId,
      report_event_id: report.id,
    })

    const result = store.getReportCloseOperationResult(operationId)
    assert.deepEqual(result, {
      reportEventId: report.id,
      chatEventId: chat.id,
      closeEventId: close.id,
      taskId: 'task-1',
      eventIds: [report.id, chat.id, close.id],
    })
    assert.equal(store.getReportCloseOperationResult('missing'), null)
  } finally {
    cleanup(store, dbPath)
  }
})

test('report-close operation recovery exposes partial report-only progress', async () => {
  const { store, dbPath } = tempStore()
  try {
    const operationId = 'fleet:agent:mcp-report:task-2:close:def456'
    const report = await store.report('fleet:agent', 'task-2', 'partial progress', {
      client_operation_id: operationId,
      close_requested: true,
    })

    const result = store.getReportCloseOperationResult(operationId)
    assert.equal(result.reportEventId, report.id)
    assert.equal(result.chatEventId, null)
    assert.equal(result.closeEventId, null)
    assert.equal(result.taskId, 'task-2')
    assert.deepEqual(result.eventIds, [report.id])
  } finally {
    cleanup(store, dbPath)
  }
})
