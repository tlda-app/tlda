import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { FleetTransportOutbox, isRetryableTransportError } from '../shared/fleet-transport-outbox.mjs'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-mcp-fleet-transport-'))
  return new Database(path.join(dir, 'outbox.sqlite'))
}

test('durable MCP operations are persisted by agent in FIFO order', () => {
  let tick = 0
  const db = tempDb()
  const outbox = new FleetTransportOutbox(db, { clock: () => `2026-07-12T00:00:0${tick++}.000Z` })

  outbox.enqueue({ operationId: 'op-1', agentId: 'fleet:a', sessionId: 's1', type: 'chat', params: { message: 'one' } })
  outbox.enqueue({ operationId: 'op-2', agentId: 'fleet:a', sessionId: 's1', type: 'chat', params: { message: 'two' } })
  outbox.enqueue({ operationId: 'op-new-session', agentId: 'fleet:a', sessionId: 's2', type: 'chat', params: { message: 'three' } })
  outbox.enqueue({ operationId: 'op-other-agent', agentId: 'fleet:b', sessionId: 's1', type: 'chat', params: { message: 'hidden' } })

  const rows = outbox.dueRows({ agentId: 'fleet:a', sessionId: 's1' })
  assert.deepEqual(rows.map(row => row.operationId), ['op-1', 'op-2', 'op-new-session'])
  assert.deepEqual(rows[0].params, { message: 'one' })
  db.close()
})

test('enqueue is idempotent by operation id', () => {
  const db = tempDb()
  const outbox = new FleetTransportOutbox(db)

  outbox.enqueue({ operationId: 'same-op', agentId: 'fleet:a', sessionId: 's1', type: 'chat', params: { message: 'original' } })
  outbox.enqueue({ operationId: 'same-op', agentId: 'fleet:a', sessionId: 's1', type: 'chat', params: { message: 'duplicate' } })

  const rows = outbox.dueRows({ agentId: 'fleet:a', sessionId: 's1' })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].params, { message: 'original' })
  db.close()
})

test('accepted operation keeps server result for duplicate callers', () => {
  const db = tempDb()
  const outbox = new FleetTransportOutbox(db)

  outbox.enqueue({ operationId: 'accepted-op', agentId: 'fleet:a', sessionId: 's1', type: 'chat', params: { _tempId: 'accepted-op' } })
  outbox.markAttempt('accepted-op')
  outbox.markAccepted('accepted-op', { ok: true, event_ids: [101] })

  const row = outbox.enqueue({ operationId: 'accepted-op', agentId: 'fleet:a', sessionId: 's1', type: 'chat', params: { _tempId: 'accepted-op' } })
  assert.equal(row.status, 'accepted')
  assert.deepEqual(row.result, { ok: true, event_ids: [101] })
  assert.deepEqual(outbox.dueRows({ agentId: 'fleet:a', sessionId: 's1' }), [])
  db.close()
})

test('retryable transport failures schedule bounded retry then dead-letter', () => {
  const db = tempDb()
  const outbox = new FleetTransportOutbox(db, { maxAttempts: 2, baseRetryMs: 1, maxRetryMs: 1 })

  outbox.enqueue({ operationId: 'retry-op', agentId: 'fleet:a', sessionId: 's1', type: 'chat', params: {} })
  outbox.markAttempt('retry-op')
  let row = outbox.markFailure('retry-op', new Error('WS connection closed'), { retryable: true })
  assert.equal(row.status, 'retrying')
  assert.match(row.lastError, /WS connection closed/)

  outbox.markAttempt('retry-op')
  row = outbox.markFailure('retry-op', new Error('WS connection closed again'), { retryable: true })
  assert.equal(row.status, 'dead')
  assert.equal(outbox.countByStatus('dead'), 1)
  db.close()
})

test('server validation failures are failed, not retried', () => {
  const db = tempDb()
  const outbox = new FleetTransportOutbox(db)

  outbox.enqueue({ operationId: 'bad-op', agentId: 'fleet:a', sessionId: 's1', type: 'chat', params: {} })
  outbox.markAttempt('bad-op')
  const row = outbox.markFailure('bad-op', new Error('No recipients matched'), { retryable: false })

  assert.equal(row.status, 'failed')
  assert.equal(outbox.countByStatus('failed'), 1)
  assert.deepEqual(outbox.dueRows({ agentId: 'fleet:a', sessionId: 's1' }), [])
  db.close()
})

test('stale inflight operations are recovered for retry by agent', () => {
  const db = tempDb()
  const outbox = new FleetTransportOutbox(db)

  outbox.enqueue({ operationId: 'stale-op', agentId: 'fleet:a', sessionId: 'old-session', type: 'chat', params: { message: 'send me' } })
  outbox.enqueue({ operationId: 'other-agent-op', agentId: 'fleet:b', sessionId: 'old-session', type: 'chat', params: { message: 'not mine' } })
  outbox.markAttempt('stale-op')
  outbox.markAttempt('other-agent-op')

  assert.equal(outbox.countByStatus('inflight'), 2)
  assert.equal(outbox.recoverInflight({ agentId: 'fleet:a' }), 1)

  const rows = outbox.dueRows({ agentId: 'fleet:a', sessionId: 'new-session' })
  assert.deepEqual(rows.map(row => row.operationId), ['stale-op'])
  assert.equal(rows[0].status, 'retrying')
  assert.match(rows[0].lastError, /MCP process restarted/)
  assert.equal(outbox.get('other-agent-op').status, 'inflight')
  db.close()
})

test('retry classifier only treats unknown socket outcomes as retryable', () => {
  assert.equal(isRetryableTransportError(new Error('WS connection closed (type=chat)')), true)
  assert.equal(isRetryableTransportError(new Error('deadline exceeded for chat')), true)
  assert.equal(isRetryableTransportError(new Error('No recipients matched: "nobody"')), false)
})
