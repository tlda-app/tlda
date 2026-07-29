import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { parseFilter } from '../shared/fleet-labels.mjs'

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

  assert.equal(store.recordRuntimeState('fleet:agent', { kind: 'ai', status: 'hibernating' }, hibernated), true)
  assert.equal(store.recordRuntimeState('fleet:agent', { kind: 'ai', status: 'hibernating' }, hibernated), false)
  assert.equal(store.recordRuntimeState('fleet:agent', { kind: 'ai', status: 'awake' }, reawakened), true)

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

test('human identity starts here and follows durable here/away transitions', () => {
  const dbPath = tempDb()
  const store = new FleetStore(dbPath, { taskDoc: false })
  const registered = '2026-07-28T09:00:00.000Z'
  insertAgent(store, 'fleet:skip', registered, { human: true })

  const away = '2026-07-28T10:00:00.000Z'
  const returned = '2026-07-28T11:00:00.000Z'
  assert.equal(store.recordRuntimeState('fleet:skip', { kind: 'human', status: 'away' }, away), true)
  assert.equal(store.recordRuntimeState('fleet:skip', { kind: 'human', status: 'here' }, returned), true)

  const spans = store.filterMembershipSpans(['here', 'away', 'human'], {})
  assert.deepEqual(
    spans.map(span => [span.label, span.fleet_id, span.from_ts, span.to_ts]),
    [
      ['away', 'fleet:skip', away, returned],
      ['here', 'fleet:skip', registered, away],
      ['here', 'fleet:skip', returned, null],
      ['human', 'fleet:skip', registered, null],
    ],
  )
  assert.throws(
    () => store.recordRuntimeState('fleet:skip', { kind: 'ai', status: 'hibernating' }, returned),
    /does not match/,
  )
  assert.throws(
    () => store.recordRuntimeState('fleet:skip', { kind: 'human', status: 'awake' }, returned),
    /human→here\|away/,
  )
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
    SELECT kind, status, from_ts, to_ts
    FROM runtime_status_history
    WHERE fleet_id = 'fleet:old' AND to_ts IS NULL
  `).get()
  assert.deepEqual(open, { kind: 'ai', status: 'awake', from_ts: minted, to_ts: null })
  assert.equal(
    migrated.db.prepare(`
      SELECT 1 FROM runtime_status_history
      WHERE fleet_id = 'fleet:old' AND status = 'dead'
    `).get(),
    undefined,
  )
  migrated.close()
})

test('migration backfill records existing humans away when startup has zero browser connections', () => {
  const dbPath = tempDb()
  const registered = '2026-07-20T10:00:00.000Z'
  const original = new FleetStore(dbPath, { taskDoc: false })
  insertAgent(original, 'fleet:skip', registered, { human: true })
  original.close()

  const db = new Database(dbPath)
  db.exec(`
    DROP TRIGGER runtime_status_history_ai;
    DROP TRIGGER runtime_status_history_au;
    DROP TABLE runtime_status_history;
  `)
  db.close()

  const migrated = new FleetStore(dbPath, { taskDoc: false })
  const rows = migrated.db.prepare(`
    SELECT kind, status, from_ts, to_ts
    FROM runtime_status_history
    WHERE fleet_id = 'fleet:skip'
    ORDER BY id
  `).all()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    kind: 'human',
    status: 'here',
    from_ts: registered,
    to_ts: rows[1].from_ts,
  })
  assert.deepEqual(rows[1], {
    kind: 'human',
    status: 'away',
    from_ts: rows[0].to_ts,
    to_ts: null,
  })
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
  assert.ok(body.indexOf('recordRuntimeState(agentId, { kind: RUNTIME_KIND.AI, status: RUNTIME_STATUS.HIBERNATING }') >
    body.indexOf('if (!detail.unknown)'))
})

test('native child membership follows the parent name and id across ingested child history', () => {
  const dbPath = tempDb()
  const store = new FleetStore(dbPath, { taskDoc: false })
  const parentRegistered = '2026-07-28T09:00:00.000Z'
  const childRegistered = '2026-07-28T10:00:00.000Z'
  insertAgent(store, 'fleet:parent', parentRegistered, { friendly_name: 'chief13' })
  insertAgent(store, 'fleet:child', childRegistered, {
    friendly_name: 'chief13:Planck',
    parent_agent_id: 'fleet:parent',
  })

  assert.deepEqual(
    store.filterMembershipSpans(['chief13', 'fleet:parent'], {})
      .filter(span => span.fleet_id === 'fleet:child')
      .map(span => [span.label, span.from_ts, span.to_ts]),
    [
      ['chief13', parentRegistered, null],
      ['fleet:parent', '1970-01-01T00:00:00.000Z', null],
    ],
  )
  assert.deepEqual(
    store.resolveChatRecipients(parseFilter('chief13')),
    ['fleet:parent'],
    'parent visibility must not turn a direct message into child fan-out',
  )
  store.close()
})

test('descendant membership spans include the full native subtree', () => {
  const dbPath = tempDb()
  const store = new FleetStore(dbPath, { taskDoc: false })
  insertAgent(store, 'fleet:parent', '2026-07-28T09:00:00.000Z')
  insertAgent(store, 'fleet:child', '2026-07-28T10:00:00.000Z', {
    parent_agent_id: 'fleet:parent',
  })
  insertAgent(store, 'fleet:grandchild', '2026-07-28T11:00:00.000Z', {
    parent_agent_id: 'fleet:child',
  })

  assert.deepEqual(
    store.filterMembershipSpans(['descendant-of:fleet:parent'], {})
      .map(span => [span.label, span.fleet_id, span.from_ts, span.to_ts]),
    [
      ['descendant-of:fleet:parent', 'fleet:child', '2026-07-28T10:00:00.000Z', null],
      ['descendant-of:fleet:parent', 'fleet:grandchild', '2026-07-28T11:00:00.000Z', null],
    ],
  )
  store.close()
})
