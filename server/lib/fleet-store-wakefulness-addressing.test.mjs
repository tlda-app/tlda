import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import { parseFilter } from '../../shared/fleet-labels.mjs'
import { RUNTIME_KIND, RUNTIME_STATUS, runtimeState } from '../../shared/fleet-runtime-status.mjs'

// The worker receives the same current runtime projection the main thread
// displays. Durable runtime history is not a second current-state source.

async function withStore(testFn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-wakefulness-'))
  try {
    await testFn(join(dir, 'fleet.db'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const NOW = '2026-08-02T06:00:00.000Z'

function seed(store) {
  store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: NOW, last_seen: NOW })
  store.upsertAgent({ id: 'fleet:riser', friendly_name: 'riser', labels: [], registered_at: NOW, last_seen: NOW })
  store.upsertAgent({ id: 'fleet:sleeper', friendly_name: 'sleeper', labels: [], registered_at: NOW, last_seen: NOW })
  store.refreshAgentLiveness('fleet:riser', runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.AWAKE))
  store.refreshAgentLiveness('fleet:sleeper', runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.HIBERNATING))
}

function recipients(store, expression) {
  return store.resolveChatRecipients(parseFilter(expression), { from: 'fleet:sender', filter: expression })
}

test('addressing awake reaches the awake agent', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'awake & riser'), ['fleet:riser'])
    store.close?.()
  })
})

test('addressing hibernating does not reach an awake agent', async () => {
  await withStore(async dbPath => {
    // The dangerous half. Before the fix this returned the agent, because every
    // agent in the store read as hibernating.
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'hibernating & riser'), [])
    store.close?.()
  })
})

test('addressing hibernating still reaches an agent that is hibernating', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'hibernating & sleeper'), ['fleet:sleeper'])
    store.close?.()
  })
})

test('waking an agent changes who awake addresses, without a restart', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'awake & sleeper'), [])

    store.refreshAgentLiveness('fleet:sleeper', runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.AWAKE))

    assert.deepEqual(recipients(store, 'awake & sleeper'), ['fleet:sleeper'])
    assert.deepEqual(recipients(store, 'hibernating & sleeper'), [])
    store.close?.()
  })
})

test('durable history does not reanimate worker routing after restart', async () => {
  await withStore(async dbPath => {
    let store = new FleetStore(dbPath)
    seed(store)
    store.recordRuntimeState('fleet:riser', runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.AWAKE), NOW)
    store.close?.()

    store = new FleetStore(dbPath)
    assert.deepEqual(recipients(store, 'awake & riser'), [])
    assert.deepEqual(recipients(store, 'hibernating & riser'), ['fleet:riser'])
    store.close?.()
  })
})
