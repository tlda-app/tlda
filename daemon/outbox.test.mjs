import fs from 'fs'
import os from 'os'
import path from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DaemonOutbox, OUTBOX_ID_FIELD } from './outbox.mjs'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-outbox-'))
  return path.join(dir, 'outbox.sqlite')
}

test('persists durable messages in FIFO order', () => {
  let tick = 0
  const outbox = new DaemonOutbox(tempDb(), { clock: () => `2026-07-10T00:00:0${tick++}.000Z` })
  const first = outbox.enqueue({ type: 'source-change', project: 'a', files: [] }, { id: 'first' })
  const second = outbox.enqueue({ type: 'terminal-chat', agent_id: 'fleet:a', text: 'hi', ts: 't' }, { id: 'second' })

  assert.equal(first, 'first')
  assert.equal(second, 'second')
  assert.equal(outbox.count(), 2)
  assert.deepEqual(outbox.pending().map(row => row.id), ['first', 'second'])
  assert.equal(outbox.pending()[0].payload[OUTBOX_ID_FIELD], 'first')
  outbox.close()
})

test('ack removes only the acknowledged message', () => {
  const outbox = new DaemonOutbox(tempDb())
  outbox.enqueue({ type: 'source-change', project: 'a', files: [] }, { id: 'first' })
  outbox.enqueue({ type: 'source-change', project: 'b', files: [] }, { id: 'second' })

  outbox.ack('first')

  assert.equal(outbox.count(), 1)
  assert.deepEqual(outbox.pending().map(row => row.id), ['second'])
  outbox.close()
})

test('survives process restart', () => {
  const dbPath = tempDb()
  {
    const outbox = new DaemonOutbox(dbPath)
    outbox.enqueue({ type: 'agent-status', agentId: 'fleet:a', state: 'working' }, { id: 'persisted' })
    outbox.close()
  }
  {
    const outbox = new DaemonOutbox(dbPath)
    const rows = outbox.pending()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'persisted')
    assert.equal(rows[0].payload.state, 'working')
    outbox.close()
  }
})

test('dead-letter preserves the row while removing it from pending retries', () => {
  let tick = 0
  const outbox = new DaemonOutbox(tempDb(), { clock: () => `2026-07-10T00:00:0${tick++}.000Z`, maxAttempts: 2 })
  outbox.enqueue({ type: 'source-change', project: 'missing-doc', files: [] }, { id: 'stale-source' })

  outbox.markAttempt('stale-source')
  assert.deepEqual(outbox.markError('stale-source', 'Project not found'), {
    deadLettered: false,
    attempts: 1,
    error: 'Project not found',
  })
  outbox.markAttempt('stale-source')
  assert.deepEqual(outbox.markError('stale-source', 'Project not found'), {
    deadLettered: true,
    attempts: 2,
    error: 'Project not found',
  })

  assert.equal(outbox.count(), 1, 'dead-lettered row is retained as evidence')
  assert.equal(outbox.pendingCount(), 0)
  assert.equal(outbox.deadLetterCount(), 1)
  assert.deepEqual(outbox.pending(), [])
  const row = outbox.get('stale-source')
  assert.equal(row.lastError, 'Project not found')
  assert.equal(row.deadLetterReason, 'Project not found')
  assert.ok(row.deadLetteredAt)
  outbox.close()
})

test('daemon outbox uses the shared fleet transport primitive', () => {
  const source = readFileSync(new URL('./outbox.mjs', import.meta.url), 'utf8')
  assert.match(source, /from '..\/shared\/fleet-transport\.mjs'/)
  assert.match(source, /new SqliteTransportOutbox/)
})
