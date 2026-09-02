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
}

const INITIAL_PROJECTIONS = {
  'fleet:riser': runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.AWAKE),
  'fleet:sleeper': runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.HIBERNATING),
}

function seedRuntime(store, projections = INITIAL_PROJECTIONS) {
  for (const [id, runtime] of Object.entries(projections)) store.refreshAgentLiveness(id, runtime)
}

function recipients(store, expression) {
  return store.resolveChatRecipients(parseFilter(expression), {
    from: 'fleet:sender',
    filter: expression,
  })
}

test('addressing awake reaches the awake agent', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    seedRuntime(store)
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
    seedRuntime(store)
    assert.deepEqual(recipients(store, 'hibernating & riser'), [])
    store.close?.()
  })
})

test('addressing hibernating still reaches an agent that is hibernating', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    seedRuntime(store)
    assert.deepEqual(recipients(store, 'hibernating & sleeper'), ['fleet:sleeper'])
    store.close?.()
  })
})

test('waking an agent changes who awake addresses, without a restart', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    seedRuntime(store)
    assert.deepEqual(recipients(store, 'awake & sleeper'), [])
    store.refreshAgentLiveness('fleet:sleeper', runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.AWAKE))
    assert.deepEqual(recipients(store, 'awake & sleeper'), ['fleet:sleeper'])
    assert.deepEqual(recipients(store, 'hibernating & sleeper'), [])
    store.close?.()
  })
})

test('production-size compound chat routing does not scan the full alive roster', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: NOW, last_seen: NOW })
    for (let i = 0; i < 1200; i++) {
      store.upsertAgent({
        id: `fleet:agent-${i}`,
        friendly_name: `agent-${i}`,
        labels: i === 777 ? ['room', 'target-777'] : ['room'],
        registered_at: NOW,
        last_seen: NOW,
      })
    }
    const originalAll = store._aliveAgentRegistry.all
    const originalFullRoster = store._getAliveAgents.all
    let fullRosterScans = 0
    store._aliveAgentRegistry.all = () => {
      fullRosterScans++
      throw new Error('full alive roster scan')
    }
    store._getAliveAgents.all = () => {
      fullRosterScans++
      throw new Error('full alive roster SQL')
    }
    try {
      assert.deepEqual(
        store.resolveChatRecipients(parseFilter('room & target-777'), {
          from: 'fleet:sender',
          filter: 'room & target-777',
        }),
        ['fleet:agent-777'],
      )
      assert.equal(fullRosterScans, 0)
    } finally {
      store._aliveAgentRegistry.all = originalAll
      store._getAliveAgents.all = originalFullRoster
      store.close?.()
    }
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
    assert.deepEqual(recipients(store, 'hibernating & riser'), [])
    store.close?.()
  })
})
