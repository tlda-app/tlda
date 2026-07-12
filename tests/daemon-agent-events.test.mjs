import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { DaemonAgentEvents } from '../server/lib/daemon-agent-events.mjs'

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-agent-events-'))
  return new Database(path.join(dir, 'events.sqlite'))
}

test('replays ordered deltas and snapshots only for an expired cursor', () => {
  const db = makeStore()
  const events = new DaemonAgentEvents(db)
  events.append('air:live', { id: 'a', state: 'idle' })
  events.append('air:live', { id: 'b', state: 'working' })
  events.append('air:live', { id: 'a', state: 'working' })
  const replay = events.replay('air:live', 1)
  assert.equal(replay.snapshot, false)
  assert.deepEqual(replay.events.map(e => e.seq), [2, 3])
  assert.deepEqual(replay.events.map(e => e.agent.id), ['b', 'a'])
  assert.equal(events.replay('air:live', -1).snapshot, true)
  db.close()
})

test('latest lookup uses daemon and agent index', () => {
  const db = makeStore()
  const events = new DaemonAgentEvents(db)
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT payload_json
    FROM daemon_agent_events
    WHERE daemon_key = ? AND agent_id = ?
    ORDER BY seq DESC
    LIMIT 1
  `).all('mini:default', 'fleet:agent')
  const detail = plan.map(row => row.detail).join('\n')
  assert.match(detail, /daemon_agent_events_latest_idx/)
  assert.doesNotMatch(detail, /SCAN daemon_agent_events/)
  db.close()
})

test('large replay gaps return a snapshot cursor instead of a large event batch', () => {
  const db = makeStore()
  const events = new DaemonAgentEvents(db)
  for (let i = 0; i < 5; i++) {
    events.append('air:live', { id: `agent-${i}`, state: 'idle' })
  }

  const replay = events.replay('air:live', 1, { limit: 2 })
  assert.equal(replay.snapshot, true)
  assert.equal(replay.lastSeq, 5)
  assert.deepEqual(replay.events, [])

  const forcedDelta = events.replay('air:live', 1, { limit: 2, snapshotOverLimit: false })
  assert.equal(forcedDelta.snapshot, false)
  assert.deepEqual(forcedDelta.events.map(e => e.seq), [2, 3])
  db.close()
})
