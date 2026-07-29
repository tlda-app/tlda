import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function insertAgent(store, row) {
  store.db.prepare(`
    INSERT INTO agents (id, parent_agent_id, friendly_name, labels, registered_at, last_seen, last_active, dead, human, metadata)
    VALUES (@id, @parentAgentId, @friendlyName, '[]', @registeredAt, @lastSeen, @lastActive, 0, 0, @metadata)
  `).run({
    id: row.id,
    parentAgentId: row.parentAgentId || null,
    friendlyName: row.friendlyName,
    registeredAt: row.registeredAt,
    lastSeen: row.lastSeen,
    lastActive: row.lastActive || row.lastSeen,
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

test('alive-agent pages keep native families whole and sort by descendant activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-roster-family-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  try {
    insertAgent(store, {
      id: 'fleet:parent-a',
      friendlyName: 'parent-a',
      registeredAt: '2026-07-27T10:00:00.000Z',
      lastSeen: '2026-07-27T10:10:00.000Z',
      lastActive: '2026-07-27T10:10:00.000Z',
    })
    insertAgent(store, {
      id: 'fleet:child-a',
      parentAgentId: 'fleet:parent-a',
      friendlyName: 'parent-a:child',
      registeredAt: '2026-07-27T10:01:00.000Z',
      lastSeen: '2026-07-27T10:12:00.000Z',
      lastActive: '2026-07-27T10:12:00.000Z',
    })
    insertAgent(store, {
      id: 'fleet:parent-b',
      friendlyName: 'parent-b',
      registeredAt: '2026-07-27T10:02:00.000Z',
      lastSeen: '2026-07-27T10:11:00.000Z',
      lastActive: '2026-07-27T10:11:00.000Z',
    })
    insertAgent(store, {
      id: 'fleet:parent-c',
      friendlyName: 'parent-c',
      registeredAt: '2026-07-27T10:03:00.000Z',
      lastSeen: '2026-07-27T10:09:00.000Z',
      lastActive: '2026-07-27T10:09:00.000Z',
    })
    insertAgent(store, {
      id: 'fleet:child-c',
      parentAgentId: 'fleet:parent-c',
      friendlyName: 'parent-c:child',
      registeredAt: '2026-07-27T10:04:00.000Z',
      lastSeen: '2026-07-27T10:08:00.000Z',
      lastActive: '2026-07-27T10:08:00.000Z',
    })

    const first = await store.getAliveAgentsPage({ limit: 2 })
    const second = await store.getAliveAgentsPage({ limit: 2, cursor: first.nextCursor })
    const third = await store.getAliveAgentsPage({ limit: 2, cursor: second.nextCursor })

    assert.deepEqual(first.agents.map(agent => agent.id), ['fleet:parent-a', 'fleet:child-a'])
    assert.deepEqual(second.agents.map(agent => agent.id), ['fleet:parent-b'])
    assert.deepEqual(third.agents.map(agent => agent.id), ['fleet:parent-c', 'fleet:child-c'])
    assert.equal(third.nextCursor, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
