import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { agentReturnNotice } from '../server/lib/agent-return-notice.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tlda-return-notice-'))
  return path.join(dir, 'fleet.db')
}

test('return notice uses hibernating runtime span instead of chat-updated last_active', async () => {
  const dbPath = tempDb()
  const store = new FleetStore(dbPath, { taskDoc: false })
  const registeredAt = '2026-07-30T10:00:00.000Z'
  const hibernatedAt = '2026-07-30T11:00:00.000Z'
  const chatDeliveredAt = '2026-07-30T16:47:30.000Z'
  store.upsertAgent({
    id: 'fleet:agent',
    friendly_name: 'agent',
    labels: [],
    registered_at: registeredAt,
    last_seen: registeredAt,
    last_active: registeredAt,
  })
  assert.equal(store.recordRuntimeState('fleet:agent', { kind: 'ai', status: 'hibernating' }, hibernatedAt), true)

  await store.insertEventRecord({
    type: 'chat',
    timestamp: chatDeliveredAt,
    from: 'fleet:skip',
    to: 'fleet:agent',
    text: 'wake up',
  })
  const agent = store.getAgent('fleet:agent')
  assert.equal(agent.last_active, chatDeliveredAt)

  const notice = await agentReturnNotice(agent, 'hibernating', {
    getCurrentRuntimeState: id => store.getCurrentRuntimeState(id),
    now: () => Date.parse(chatDeliveredAt),
  })

  assert.equal(notice, 'You were away as hibernating for 5 hours.')
  store.close()
})

test('current runtime state exposes the open durable liveness span', () => {
  const dbPath = tempDb()
  const store = new FleetStore(dbPath, { taskDoc: false })
  const registeredAt = '2026-07-30T10:00:00.000Z'
  const hibernatedAt = '2026-07-30T11:00:00.000Z'
  store.upsertAgent({
    id: 'fleet:agent',
    friendly_name: 'agent',
    labels: [],
    registered_at: registeredAt,
  })
  store.recordRuntimeState('fleet:agent', { kind: 'ai', status: 'hibernating' }, hibernatedAt)

  assert.deepEqual(store.getCurrentRuntimeState('fleet:agent'), {
    fleet_id: 'fleet:agent',
    kind: 'ai',
    status: 'hibernating',
    from_ts: hibernatedAt,
    to_ts: null,
  })
  store.close()
})
