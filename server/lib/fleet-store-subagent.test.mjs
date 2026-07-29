import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStoreClient } from './fleet-store-client.mjs'
import { FleetStore } from './fleet-store.mjs'

test('agent parent relationship is stored and returned as ordinary roster data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-subagent-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const now = new Date().toISOString()
    await store.upsertAgent({
      id: 'fleet:parent',
      friendly_name: 'parent',
      labels: [],
      registered_at: now,
      last_seen: now,
    })
    await store.upsertAgent({
      id: 'fleet:child',
      parent_agent_id: 'fleet:parent',
      friendly_name: 'parent:child',
      labels: [],
      registered_at: now,
      last_seen: now,
    })

    assert.equal((await store.getAgent('fleet:child')).parent_agent_id, 'fleet:parent')
    assert.equal(
      (await store.getAliveAgents()).find(agent => agent.id === 'fleet:child')?.parent_agent_id,
      'fleet:parent',
    )

    await store.upsertAgent({
      id: 'fleet:child',
      friendly_name: 'parent:child',
      labels: [],
      last_seen: new Date().toISOString(),
    })
    assert.equal((await store.getAgent('fleet:child')).parent_agent_id, 'fleet:parent')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native child binding is atomic across retry and permits a dead parent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-subagent-binding-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const now = new Date().toISOString()
    await store.upsertAgent({
      id: 'fleet:dead-parent',
      friendly_name: 'dead-parent',
      labels: [],
      registered_at: now,
      last_seen: now,
      dead: true,
    })

    const first = store.registerNativeSubagent({
      bindingKey: 'subagent-observed:stable-binding',
      parentAgentId: 'fleet:dead-parent',
      childAgentId: 'fleet:first-child-id',
      requestedName: 'dead-parent:worker',
      now,
    })
    assert.equal(first.created, true)
    assert.equal(first.agent.id, 'fleet:first-child-id')
    assert.equal(first.agent.parent_agent_id, 'fleet:dead-parent')

    const retry = store.registerNativeSubagent({
      bindingKey: 'subagent-observed:stable-binding',
      parentAgentId: 'fleet:dead-parent',
      childAgentId: 'fleet:must-not-be-created',
      requestedName: 'dead-parent:different-name',
      now: new Date().toISOString(),
    })
    assert.equal(retry.created, false)
    assert.equal(retry.agent.id, 'fleet:first-child-id')
    assert.equal(store.getAgent('fleet:must-not-be-created'), null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('native child binding crosses the store worker boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-subagent-client-'))
  const store = new FleetStoreClient(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    await store.ready()
    await store.upsertAgent({
      id: 'fleet:worker-parent',
      friendly_name: 'worker-parent',
      labels: [],
      dead: true,
    })
    const first = await store.registerNativeSubagent({
      bindingKey: 'subagent-observed:worker-binding',
      parentAgentId: 'fleet:worker-parent',
      childAgentId: 'fleet:worker-child',
      requestedName: 'worker-parent:child',
    })
    const retry = await store.registerNativeSubagent({
      bindingKey: 'subagent-observed:worker-binding',
      parentAgentId: 'fleet:worker-parent',
      childAgentId: 'fleet:worker-duplicate',
      requestedName: 'worker-parent:other',
    })
    assert.equal(first.created, true)
    assert.equal(retry.created, false)
    assert.equal(retry.agent.id, 'fleet:worker-child')
    assert.equal(await store.getAgent('fleet:worker-duplicate'), null)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
