import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tlda-filter-membership-'))
  return path.join(dir, 'fleet.db')
}

function insertAgent(store, id, registeredAt, extra = {}) {
  store.upsertAgent({
    id,
    friendly_name: id.slice('fleet:'.length),
    labels: [],
    registered_at: registeredAt,
    ...extra,
  })
}

test('runtime membership starts awake at mint and follows durable transitions', () => {
  const dbPath = tempDb()
  const store = new FleetStore(dbPath, { taskDoc: false })
  const minted = '2026-07-28T10:00:00.000Z'
  const hibernated = '2026-07-28T11:00:00.000Z'
  const reawakened = '2026-07-28T12:00:00.000Z'
  insertAgent(store, 'fleet:agent', minted)

  assert.equal(store.recordRuntimeStatus('fleet:agent', 'hibernating', hibernated), true)
  assert.equal(store.recordRuntimeStatus('fleet:agent', 'hibernating', hibernated), false)
  assert.equal(store.recordRuntimeStatus('fleet:agent', 'awake', reawakened), true)

  assert.deepEqual(
    store.filterMembershipSpans(['awake', 'hibernating'], {}).map(span => ({
      label: span.label,
      from: span.from_ts,
      to: span.to_ts,
    })),
    [
      { label: 'awake', from: minted, to: hibernated },
      { label: 'awake', from: reawakened, to: null },
      { label: 'hibernating', from: hibernated, to: reawakened },
    ],
  )
  store.close()
})

test('human identity has non-nullable awake status from registration', () => {
  const dbPath = tempDb()
  const store = new FleetStore(dbPath, { taskDoc: false })
  const registered = '2026-07-28T09:00:00.000Z'
  insertAgent(store, 'fleet:skip', registered, { human: true })

  const spans = store.filterMembershipSpans(['awake', 'human'], {})
  assert.deepEqual(
    spans.map(span => [span.label, span.fleet_id, span.from_ts, span.to_ts]),
    [
      ['awake', 'fleet:skip', registered, null],
      ['human', 'fleet:skip', registered, null],
    ],
  )
  assert.equal(store.recordRuntimeStatus('fleet:skip', 'hibernating', '2026-07-28T10:00:00.000Z'), false)
  store.close()
})

test('migration backfill keeps awake from mint without inventing a death timestamp', () => {
  const dbPath = tempDb()
  const minted = '2026-07-20T10:00:00.000Z'
  const original = new FleetStore(dbPath, { taskDoc: false })
  insertAgent(original, 'fleet:old', minted)
  original.markDead('fleet:old')
  original.close()

  const db = new Database(dbPath)
  db.exec(`
    DROP TRIGGER runtime_status_history_ai;
    DROP TRIGGER runtime_status_history_au;
    DROP TABLE runtime_status_history;
  `)
  db.close()

  const migrated = new FleetStore(dbPath, { taskDoc: false })
  const spans = migrated.filterMembershipSpans(['awake'], {})
  assert.equal(spans.length, 1)
  assert.equal(spans[0].fleet_id, 'fleet:old')
  assert.equal(spans[0].from_ts, minted)
  assert.equal(spans[0].to_ts, null)

  const open = migrated.db.prepare(`
    SELECT status, from_ts, to_ts
    FROM runtime_status_history
    WHERE fleet_id = 'fleet:old' AND to_ts IS NULL
  `).get()
  assert.deepEqual(open, { status: 'awake', from_ts: minted, to_ts: null })
  assert.equal(
    migrated.db.prepare(`
      SELECT 1 FROM runtime_status_history
      WHERE fleet_id = 'fleet:old' AND status = 'dead'
    `).get(),
    undefined,
  )
  migrated.close()
})

test('unknown liveness does not write a hibernating transition', () => {
  const source = readFileSync(
    new URL('../server/unified-server.mjs', import.meta.url),
    'utf8',
  )
  const start = source.indexOf('function markAgentNotAlive(')
  const end = source.indexOf('function recordExplicitCheckAliveLiveness(', start)
  const body = source.slice(start, end)
  assert.ok(body.includes('if (!detail.unknown)'))
  assert.ok(body.indexOf("recordRuntimeStatus(agentId, 'hibernating'") >
    body.indexOf('if (!detail.unknown)'))
})
