import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempStore() {
  const dbPath = path.join(os.tmpdir(), `fleet-heartbeat-lifecycle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return { store: new FleetStore(dbPath), dbPath }
}

function cleanup(store, dbPath) {
  store.close()
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort temp cleanup */ }
  }
}

test('passive heartbeat and inbox acknowledgement do not reanimate a killed agent', async () => {
  const { store, dbPath } = tempStore()
  const agentId = 'fleet:killed-agent'
  try {
    store.upsertAgent({
      id: agentId,
      friendly_name: 'killed-agent',
      labels: [],
      last_seen: '2026-01-01T00:00:00.000Z',
      dead: false,
    })
    store.markDead(agentId)

    store.updateHeartbeat(agentId)
    const afterHeartbeat = store.getAgent(agentId)
    assert.notEqual(afterHeartbeat.last_seen, '2026-01-01T00:00:00.000Z')
    assert.equal(afterHeartbeat.dead, true)

    await store.acknowledgeInboxRead(agentId, [])
    assert.equal(store.getAgent(agentId).dead, true)
    assert.deepEqual(store.getAliveAgents().map(agent => agent.id), [])
  } finally {
    cleanup(store, dbPath)
  }
})

test('explicit reanimation remains authoritative after a kill', () => {
  const { store, dbPath } = tempStore()
  const agentId = 'fleet:explicitly-reanimated-agent'
  try {
    store.upsertAgent({
      id: agentId,
      friendly_name: 'explicitly-reanimated-agent',
      labels: [],
      dead: false,
    })
    store.markDead(agentId)

    assert.deepEqual(store.resurrectAsZombie(agentId), { ok: true, zombie: false })
    assert.equal(store.getAgent(agentId).dead, false)
    assert.deepEqual(store.getAliveAgents().map(agent => agent.id), [agentId])
  } finally {
    cleanup(store, dbPath)
  }
})
