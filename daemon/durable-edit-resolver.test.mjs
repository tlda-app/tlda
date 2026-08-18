import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DaemonDeliveryRuntime } from './delivery-runtime.mjs'
import { EditOperationStore } from './edit-operation-store.mjs'
import { DaemonOutbox } from './outbox.mjs'
import { createSourceSync } from './source-sync.mjs'

const quiet = { info() {}, warn() {}, error() {} }

function fixture(root = mkdtempSync(join(tmpdir(), 'tlda-durable-edit-')), retryFault = null) {
  const operations = new EditOperationStore(join(root, 'operations.sqlite'))
  const outbox = new DaemonOutbox(join(root, 'outbox.sqlite'))
  let sync
  const ackGate = payload => {
    const disposition = operations.disposition(payload.__daemon_outbox_id)
    if (!disposition) return !(payload.editOperations?.length || payload.editOperation)
    if (disposition.kind === 'retry_pending') return disposition.retry_enqueued === 1 && !!outbox.get(disposition.retry_outbox_id)
    return disposition.operationIds.every(id => operations.state(id)?.state !== 'pending')
  }
  const delivery = new DaemonDeliveryRuntime({
    inflightDeadlineMs: 120_000,
    flushByteBudget: 1_048_576,
    outbox, send: () => false, isConnected: () => false, isReady: () => false,
    beforeSend: message => { if (message.type === 'source-change') sync.restoreDurableSourceChange(message) },
    ackGate,
  })
  sync = createSourceSync({
  sourceChangeSettleDeadlineMs: 300_000,
    sourceBindingsFile: join(root, 'bindings.json'), log: quiet,
    sendMsg: message => delivery.send(message), isConnected: () => false,
    resolveEditor: () => [], editOperationStore: operations,
    verifyOutbox: id => outbox.get(id), retryFault, watch: () => { throw new Error('watch not expected') },
  })
  return { root, operations, outbox, delivery, sync, close() { sync.closeAll(); operations.close(); outbox.close() } }
}

test('stale result records retry disposition before deterministic explicit-id enqueue', () => {
  const f = fixture()
  try {
    const operation = { operation_id: 'O1', kind: 'Edit', path: '/tmp/main.tex', changes: [] }
    f.operations.record('agent', '/tmp/main.tex', operation)
    const first = { type: 'source-change', project: 'paper', requestId: 'R1', expectedRevision: 'rev-1', files: [], sourceManifest: [], editOperations: [{ agentId: 'agent', operation }], __daemon_outbox_id: 'D1' }
    f.delivery.send(first)
    f.sync.restoreDurableSourceChange(first)
    assert.equal(f.sync.handleSourceChangeResult({ type: 'source-change-result', project: 'paper', requestId: 'R1', outbox_id: 'D1', ok: false, status: 'stale-base', authority: { currentRevision: 'rev-2' } }), true)
    const disposition = f.operations.disposition('D1')
    assert.equal(disposition.kind, 'retry_pending')
    assert.equal(disposition.retry_enqueued, 1)
    assert.equal(f.outbox.get(disposition.retry_outbox_id).payload.requestId, disposition.retry_request_id)
    assert.equal(f.delivery.handleAck('D1'), true)
    assert.equal(f.outbox.get('D1'), null)
    assert.equal(f.operations.state('O1').state, 'pending')
  } finally { f.close(); rmSync(f.root, { recursive: true, force: true }) }
})

test('retry recovery survives the disposition/enqueue crash boundary', () => {
  const f = fixture()
  try {
    const retryPayload = { type: 'source-change', project: 'paper', requestId: 'R2', expectedRevision: 'rev-2', files: [], sourceManifest: [], __daemon_outbox_id: 'D2' }
    const fingerprint = createHash('sha256').update(JSON.stringify(retryPayload)).digest('hex')
    f.operations.applyDisposition({ outboxId: 'D1', kind: 'retry_pending', operationIds: [], retry: { outboxId: 'D2', requestId: 'R2', fingerprint, payload: retryPayload } })
    assert.equal(f.outbox.get('D2'), null)
    f.sync.recoverRetries()
    assert.deepEqual(f.outbox.get('D2').payload, retryPayload)
    assert.equal(f.operations.disposition('D1').retry_enqueued, 1)
  } finally { f.close(); rmSync(f.root, { recursive: true, force: true }) }
})

for (const boundary of ['before-disposition', 'after-disposition', 'after-outbox-insert', 'after-retry-enqueued']) {
  test(`retry survives restart at ${boundary}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tlda-retry-crash-'))
    let f = fixture(root, stage => { if (stage === boundary) throw new Error(`crash:${stage}`) })
    const operation = { operation_id: 'O1', kind: 'Edit', path: '/tmp/main.tex', changes: [] }
    const first = { type: 'source-change', project: 'paper', requestId: 'R1', expectedRevision: 'rev-1', files: [], sourceManifest: [], editOperations: [{ agentId: 'agent', operation }], __daemon_outbox_id: 'D1' }
    const result = { type: 'source-change-result', project: 'paper', requestId: 'R1', outbox_id: 'D1', ok: false, status: 'stale-base', authority: { currentRevision: 'rev-2' } }
    try {
      f.operations.record('agent', '/tmp/main.tex', operation)
      f.delivery.send(first)
      f.sync.restoreDurableSourceChange(first)
      assert.throws(() => f.sync.handleSourceChangeResult(result), new RegExp(`crash:${boundary}`))
      f.close()

      f = fixture(root)
      if (boundary === 'before-disposition') {
        f.sync.restoreDurableSourceChange(first)
        assert.equal(f.sync.handleSourceChangeResult(result), true)
      } else {
        f.sync.recoverRetries()
      }

      const disposition = f.operations.disposition('D1')
      assert.equal(disposition.kind, 'retry_pending')
      assert.equal(disposition.retry_enqueued, 1)
      const retry = f.outbox.get(disposition.retry_outbox_id)
      assert.ok(retry)
      assert.equal(createHash('sha256').update(JSON.stringify(retry.payload)).digest('hex'), disposition.retry_fingerprint)
      assert.equal(f.delivery.handleAck('D1'), true)
      assert.equal(f.outbox.get('D1'), null)
      assert.equal(f.operations.state('O1').state, 'pending')
    } finally {
      f.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
