// The inflight-deadline release used to log and forget: a row the server took
// and never answered was re-offered with no durable trace of the silence.
// Recording is observability only -- it must not touch attempts, last_error,
// pending eligibility, or dead-letter state.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { DaemonOutbox } from './outbox.mjs'
import { DaemonDeliveryRuntime } from './delivery-runtime.mjs'

const DEADLINE_MS = 120_000
const ISO = '2026-09-27T10:00:00.000Z'

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-unanswered-record-'))
  const clock = { ms: 1_000_000 }
  const outbox = new DaemonOutbox(join(dir, 'outbox.sqlite'), { clock: () => ISO })
  const sent = []
  const delivery = new DaemonDeliveryRuntime({
    outbox,
    send: message => { sent.push(message); return true },
    isConnected: () => true,
    isReady: () => true,
    inflightDeadlineMs: DEADLINE_MS,
    flushByteBudget: 1_048_576,
    now: () => clock.ms,
  })
  t.after(() => {
    delivery.dispose()
    outbox.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, clock, outbox, delivery, sent }
}

const ids = outbox => outbox.pending(10).map(r => r.id)

test('an unanswered expiry persists a count and timestamp and leaves the row pending', t => {
  const { clock, outbox, delivery, sent } = harness(t)
  delivery.send({ type: 'agent-route', agent_id: 'fleet:seat' })
  delivery.flushDurable()
  assert.equal(sent.length, 1)
  const [id] = ids(outbox)

  clock.ms += DEADLINE_MS + 1
  delivery.flushDurable()

  const row = outbox.get(id)
  assert.equal(row.unansweredCount, 1)
  assert.equal(row.lastUnansweredAt, ISO)
  assert.deepEqual(ids(outbox), [id], 'recording must not change pending eligibility')
  assert.equal(row.attempts, 2, 'only the two sends count as attempts')
  assert.equal(row.lastError, null, 'recording must not clobber last_error')
  assert.equal(row.deadLetteredAt, null)
  assert.equal(sent.length, 2, 'the row is still re-offered')

  clock.ms += DEADLINE_MS + 1
  delivery.flushDurable()
  assert.equal(outbox.get(id).unansweredCount, 2, 'the count accumulates across expiries')
})

test('recording an id the ledger no longer holds is a no-op, not a throw', t => {
  const { outbox } = harness(t)
  assert.doesNotThrow(() => outbox.recordUnanswered('no-such-row'))
})

test('a legacy database without the columns migrates on open', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-unanswered-legacy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'outbox.sqlite')
  const legacy = new Database(file)
  legacy.exec(`
    CREATE TABLE daemon_outbox (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_attempt_at TEXT,
      last_error TEXT,
      dead_lettered_at TEXT,
      dead_letter_reason TEXT
    );
    INSERT INTO daemon_outbox (id, type, payload_json, attempts, created_at)
    VALUES ('legacy-1', 'agent-route', '{"type":"agent-route"}', 7, '2026-09-20T00:00:00.000Z');
  `)
  legacy.close()

  const outbox = new DaemonOutbox(file, { clock: () => ISO })
  t.after(() => outbox.close())
  outbox.recordUnanswered('legacy-1')
  const row = outbox.get('legacy-1')
  assert.equal(row.unansweredCount, 1)
  assert.equal(row.lastUnansweredAt, ISO)
  assert.equal(row.attempts, 7, 'migration and recording must not rewrite attempts')
})
