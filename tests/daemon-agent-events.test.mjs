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
