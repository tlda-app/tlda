import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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

test('native subagent notification stores only routing metadata and clears on parent send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-subagent-notification-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    const now = '2026-07-29T10:00:00.000Z'
    await store.upsertAgent({ id: 'fleet:parent', friendly_name: 'parent', labels: [], registered_at: now, last_seen: now })
    await store.upsertAgent({
      id: 'fleet:child',
      parent_agent_id: 'fleet:parent',
      friendly_name: 'parent:child',
      labels: [],
      registered_at: now,
      last_seen: now,
    })
    await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })

    await store.createNativeSubagentNotification({
      eventId: 42,
      parentAgentId: 'fleet:parent',
      childAgentId: 'fleet:child',
      senderAgentId: 'fleet:sender',
      createdAt: now,
    })
    const rows = await store.getPendingNativeSubagentNotifications('fleet:parent')
    assert.deepEqual(rows, [{
      event_id: 42,
      parent_agent_id: 'fleet:parent',
      child_agent_id: 'fleet:child',
      sender_agent_id: 'fleet:sender',
      created_at: now,
      child_name: 'parent:child',
      sender_name: 'sender',
    }])
    assert.equal(Object.hasOwn(rows[0], 'text'), false)

    assert.deepEqual(
      await store.acknowledgeNativeSubagentNotifications('fleet:parent', 'fleet:child'),
      { acknowledged: 1 },
    )
    assert.deepEqual(await store.getPendingNativeSubagentNotifications('fleet:parent'), [])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
