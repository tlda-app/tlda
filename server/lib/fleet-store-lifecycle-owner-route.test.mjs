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

test('conditional pending-shell retirement closes tasks and releases the name only when it wins', async () => {
  const { dir, store } = createStore()
  try {
    store.upsertAgent({
      id: 'fleet:pending',
      friendly_name: 'conditional-shell',
      labels: [],
      registered_at: '2026-08-08T00:00:00.000Z',
      dead: false,
      metadata: { shell: true },
    })
    store.upsertTask({ id: 'fleet:pending-task', agent: 'fleet:pending', description: 'pending shell work', status: 'pending' })

    assert.equal(store.retirePendingShell('fleet:pending'), true)
    assert.equal(store.getAgent('fleet:pending').dead, true)
    assert.deepEqual(store.getActiveTasksByAgent('fleet:pending'), [])
    assert.equal(await store.allocateFreshFriendlyName('conditional-shell', { excludeId: 'fleet:replacement' }), 'conditional-shell')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('conditional pending-shell retirement cannot kill a claimed agent or retire its task', () => {
  const { dir, store } = createStore()
  try {
    store.upsertAgent({
      id: 'fleet:claimed',
      friendly_name: 'claimed-shell',
      labels: [],
      registered_at: '2026-08-08T00:00:00.000Z',
      dead: false,
      metadata: { shell: null },
    })
    store.upsertTask({ id: 'fleet:claimed-task', agent: 'fleet:claimed', description: 'claimed agent work', status: 'pending' })

    assert.equal(store.retirePendingShell('fleet:claimed'), false)
    assert.equal(store.getAgent('fleet:claimed').dead, false)
    assert.equal(store.getActiveTasksByAgent('fleet:claimed').length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
