import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-label-history-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    return run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function labelEvents(store, id) {
  return store.db.prepare(`
    SELECT id, type, timestamp, metadata
    FROM events
    WHERE agent_id = ?
      AND json_type(metadata, '$.label_state.labels') = 'array'
    ORDER BY timestamp, id
  `).all(id).map(row => ({ ...row, metadata: JSON.parse(row.metadata) }))
}

test('add/remove accept scalar or list and replace is the complete list', () => withStore(store => {
  store.upsertAgent({
    id: 'fleet:labels',
    friendly_name: 'labels',
    labels: ['one'],
    registered_at: '2026-07-30T00:00:00.000Z',
  })
  store.mutateAgentLabels('fleet:labels', 'add', 'two', { timestamp: '2026-07-30T00:01:00.000Z' })
  store.mutateAgentLabels('fleet:labels', 'add', ['two', 'three'], { timestamp: '2026-07-30T00:02:00.000Z' })
  store.mutateAgentLabels('fleet:labels', 'remove', ['one', 'missing'], { timestamp: '2026-07-30T00:03:00.000Z' })
  const cleared = store.mutateAgentLabels('fleet:labels', 'replace', [], { timestamp: '2026-07-30T00:04:00.000Z' })

  assert.deepEqual(cleared.labels, [])
  assert.deepEqual(store.getAgent('fleet:labels').labels, [])
  assert.deepEqual(
    labelEvents(store, 'fleet:labels').map(event => event.metadata.label_state),
    [
      { labels: ['one'], operation: 'register' },
      { labels: ['one', 'two'], operation: 'add' },
      { labels: ['one', 'two', 'three'], operation: 'add' },
      { labels: ['two', 'three'], operation: 'remove' },
      { labels: [], operation: 'replace' },
    ],
  )
  assert.throws(() => store.mutateAgentLabels('fleet:labels', 'replace', 'bad'), /complete labels must be a list/)
}))

test('projection replay is deterministic for out-of-order and equal timestamps', () => withStore(store => {
  store.upsertAgent({
    id: 'fleet:chronology',
    labels: ['initial'],
    registered_at: '2026-07-30T00:00:00.000Z',
  })
  store.mutateAgentLabels('fleet:chronology', 'replace', ['late'], { timestamp: '2026-07-30T00:02:00.000Z' })
  store.mutateAgentLabels('fleet:chronology', 'replace', ['middle-a'], { timestamp: '2026-07-30T00:01:00.000Z' })
  store.mutateAgentLabels('fleet:chronology', 'replace', ['middle-b'], { timestamp: '2026-07-30T00:01:00.000Z' })

  const rows = store.db.prepare(`
    SELECT labels, from_ts, to_ts FROM label_history
    WHERE fleet_id = ? ORDER BY from_ts, id
  `).all('fleet:chronology')
  assert.deepEqual(rows, [
    { labels: '["initial"]', from_ts: '2026-07-30T00:00:00.000Z', to_ts: '2026-07-30T00:01:00.000Z' },
    { labels: '["middle-a"]', from_ts: '2026-07-30T00:01:00.000Z', to_ts: '2026-07-30T00:01:00.000Z' },
    { labels: '["middle-b"]', from_ts: '2026-07-30T00:01:00.000Z', to_ts: '2026-07-30T00:02:00.000Z' },
    { labels: '["late"]', from_ts: '2026-07-30T00:02:00.000Z', to_ts: null },
  ])
  assert.deepEqual(store.getAgent('fleet:chronology').labels, ['late'])
}))

test('omitted-label upserts preserve current state and do not emit label events', () => withStore(store => {
  store.upsertAgent({ id: 'fleet:preserve', labels: ['kept'], registered_at: '2026-07-30T00:00:00.000Z' })
  const before = labelEvents(store, 'fleet:preserve')
  store.upsertAgent({ id: 'fleet:preserve', last_seen: '2026-07-30T00:05:00.000Z' })
  assert.deepEqual(store.getAgent('fleet:preserve').labels, ['kept'])
  assert.deepEqual(labelEvents(store, 'fleet:preserve'), before)
}))

test('agent state, event, and projection roll back together on projection failure', () => withStore(store => {
  store.upsertAgent({ id: 'fleet:atomic', labels: ['before'], registered_at: '2026-07-30T00:00:00.000Z' })
  const eventCount = labelEvents(store, 'fleet:atomic').length
  store.db.exec(`
    CREATE TRIGGER fail_label_projection BEFORE INSERT ON label_history
    WHEN NEW.fleet_id = 'fleet:atomic'
    BEGIN SELECT RAISE(ABORT, 'projection failure'); END;
  `)
  assert.throws(
    () => store.mutateAgentLabels('fleet:atomic', 'replace', ['after']),
    /projection failure/,
  )
  assert.deepEqual(store.getAgent('fleet:atomic').labels, ['before'])
  assert.equal(labelEvents(store, 'fleet:atomic').length, eventCount)
}))

test('living friendly names block labels and dead names are reusable', () => withStore(store => {
  store.upsertAgent({
    id: 'fleet:holder',
    friendly_name: 'held-name',
    labels: [],
    registered_at: '2026-07-30T00:00:00.000Z',
  })
  store.upsertAgent({
    id: 'fleet:target',
    friendly_name: 'target',
    labels: ['before'],
    registered_at: '2026-07-30T00:00:01.000Z',
  })
  const before = labelEvents(store, 'fleet:target').length
  assert.throws(
    () => store.mutateAgentLabels('fleet:target', 'add', 'held-name'),
    /Label collision: held-name/,
  )
  assert.deepEqual(store.getAgent('fleet:target').labels, ['before'])
  assert.equal(labelEvents(store, 'fleet:target').length, before)

  store.upsertAgent({ id: 'fleet:holder', dead: true })
  assert.deepEqual(
    store.mutateAgentLabels('fleet:target', 'add', 'held-name').labels,
    ['before', 'held-name'],
  )
}))

test('offline mixed-state migration fills missing canonical agents then rebuilds', () => withStore(store => {
  store.upsertAgent({ id: 'fleet:seeded', labels: ['seeded'], registered_at: '2026-07-30T00:00:00.000Z' })
  store.upsertAgent({ id: 'fleet:missing', labels: ['missing'], registered_at: '2026-07-30T00:01:00.000Z' })
  store.db.prepare(`
    DELETE FROM events
    WHERE agent_id = 'fleet:missing'
      AND json_type(metadata, '$.label_state.labels') = 'array'
  `).run()
  store.db.prepare('DELETE FROM label_history WHERE fleet_id = ?').run('fleet:missing')
  store.db.prepare(`
    INSERT INTO label_history (fleet_id, labels, from_ts, to_ts)
    VALUES ('fleet:garbage', '["garbage"]', '1999-01-01T00:00:00.000Z', NULL)
  `).run()

  assert.deepEqual(store.migrateExistingAgentLabelsToEvents(), { events: 1 })
  assert.equal(labelEvents(store, 'fleet:seeded').length, 1)
  assert.deepEqual(labelEvents(store, 'fleet:missing')[0].metadata.label_state, {
    labels: ['missing'],
    operation: 'migration',
  })
  assert.deepEqual(
    store.db.prepare('SELECT fleet_id FROM label_history ORDER BY fleet_id').all(),
    [{ fleet_id: 'fleet:missing' }, { fleet_id: 'fleet:seeded' }],
  )
}))
