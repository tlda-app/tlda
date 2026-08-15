import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-lifecycle-owner-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  return { dir, store }
}

function insertAgent(store, id = 'fleet:agent') {
  store.upsertAgent({
    id,
    friendly_name: id.slice('fleet:'.length),
    labels: [],
    registered_at: '2026-08-08T00:00:00.000Z',
  })
  store.setAgentDaemonRoute(id, 'mini:testing')
}

test('death keeps only the daemon owner address needed for reanimate', () => {
  const { dir, store } = createStore()
  try {
    insertAgent(store)
    store.db.prepare(`
      INSERT INTO tasks (id, agent, description, status)
      VALUES ('fleet:task', 'fleet:agent', 'unfinished work', 'pending')
    `).run()

    store.markDead('fleet:agent')

    assert.equal(store.getAgent('fleet:agent').dead, true)
    assert.deepEqual(store.getAgentDaemonRoute('fleet:agent'), {
      agent_id: 'fleet:agent',
      daemon_key: 'mini:testing',
    })
    assert.deepEqual(store.getAgentsByDaemonKey('mini:testing'), [])
    assert.deepEqual(store.getActiveTasksByAgent('fleet:agent'), [])

    const reanimated = store.markAlive('fleet:agent')
    assert.equal(reanimated.dead, false)
    assert.deepEqual(store.getAgentDaemonRoute('fleet:agent'), {
      agent_id: 'fleet:agent',
      daemon_key: 'mini:testing',
    })
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit deletion removes the daemon owner address', () => {
  const { dir, store } = createStore()
  try {
    insertAgent(store)

    store.removeAgent('fleet:agent')

    assert.equal(store.getAgent('fleet:agent'), null)
    assert.equal(store.getAgentDaemonRoute('fleet:agent'), null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
