import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function insertAgent(store, row) {
  store.db.prepare(`
    INSERT INTO agents (id, friendly_name, labels, registered_at, last_seen, dead, human, metadata)
    VALUES (@id, @friendlyName, '[]', @registeredAt, @lastSeen, 0, 0, @metadata)
  `).run({
    id: row.id,
    friendlyName: row.friendlyName,
    registeredAt: row.registeredAt,
    lastSeen: row.lastSeen,
    metadata: JSON.stringify(row.metadata || {}),
  })
}

test('shell reservations are not roster agents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-roster-agent-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  try {
    insertAgent(store, {
      id: 'fleet:real',
      friendlyName: 'real-agent',
      registeredAt: '2026-07-27T10:00:00.000Z',
      lastSeen: '2026-07-27T10:10:00.000Z',
    })
    insertAgent(store, {
      id: 'fleet:shell',
      friendlyName: 'reserved-shell',
      registeredAt: '2026-07-27T10:01:00.000Z',
      lastSeen: '2026-07-27T10:11:00.000Z',
      metadata: { shell: true },
    })

    assert.deepEqual((await store.getAliveAgents()).map(agent => agent.id), ['fleet:real'])
    assert.deepEqual((await store.getAliveAgentsPage({ limit: 10 })).agents.map(agent => agent.id), ['fleet:real'])
    assert.equal((await store.getAliveAgentCounts()).total, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
