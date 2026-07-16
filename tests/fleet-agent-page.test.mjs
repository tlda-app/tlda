import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempStore() {
  const dbPath = path.join(os.tmpdir(), `fleet-agent-page-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { store: new FleetStore(dbPath), dbPath }
}

function cleanup(store, dbPath) {
  store.close()
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort cleanup */ }
  }
}

test('live-agent pages are bounded, cursor-indexed, and omit dead agents', () => {
  const { store, dbPath } = tempStore()
  try {
    store.upsertAgent({ id: 'fleet:awake', friendly_name: 'awake', last_seen: '2026-07-12T12:00:03.000Z' })
    store.upsertAgent({ id: 'fleet:hibernating', friendly_name: 'hibernating', last_seen: '2026-07-12T12:00:02.000Z' })
    store.upsertAgent({ id: 'fleet:dead', friendly_name: 'dead', dead: true, last_seen: '2026-07-12T12:00:01.000Z' })

    const first = store.getAliveAgentsPage({ limit: 1 })
    assert.deepEqual(first.agents.map(a => a.id), ['fleet:awake'])
    assert.ok(first.nextCursor)

    const second = store.getAliveAgentsPage({ limit: 1, cursor: first.nextCursor })
    assert.deepEqual(second.agents.map(a => a.id), ['fleet:hibernating'])
    assert.equal(second.nextCursor, null)
    assert.equal([...first.agents, ...second.agents].some(a => a.id === 'fleet:dead'), false)
  } finally {
    cleanup(store, dbPath)
  }
})

test('live-agent page rejects malformed cursors', () => {
  const { store, dbPath } = tempStore()
  try {
    assert.throws(() => store.getAliveAgentsPage({ cursor: 'not-a-cursor' }), /invalid agents cursor/)
  } finally {
    cleanup(store, dbPath)
  }
})

test('full roster counts do not change with the requested page', () => {
  const { store, dbPath } = tempStore()
  try {
    store.setRuntimeStatusProvider(agent => ({ status: agent.id === 'fleet:awake' ? 'awake' : 'hibernating' }))
    store.upsertAgent({ id: 'fleet:awake', friendly_name: 'awake', last_seen: '2026-07-12T12:00:03.000Z' })
    store.upsertAgent({ id: 'fleet:hibernating-a', friendly_name: 'hibernating-a', last_seen: '2026-07-12T12:00:02.000Z' })
    store.upsertAgent({ id: 'fleet:hibernating-b', friendly_name: 'hibernating-b', last_seen: '2026-07-12T12:00:01.000Z' })

    const first = store.getAliveAgentsPage({ limit: 1 })
    const beforeScroll = store.getAliveAgentCounts()
    const second = store.getAliveAgentsPage({ limit: 1, cursor: first.nextCursor })
    const afterScroll = store.getAliveAgentCounts()

    assert.equal(first.agents.length, 1)
    assert.equal(second.agents.length, 1)
    assert.deepEqual(beforeScroll, { awake: 1, hibernating: 2, total: 3 })
    assert.deepEqual(afterScroll, beforeScroll)
  } finally {
    cleanup(store, dbPath)
  }
})
