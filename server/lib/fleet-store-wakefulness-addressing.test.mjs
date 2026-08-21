import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import { parseFilter } from '../../shared/fleet-labels.mjs'
import { RUNTIME_KIND, RUNTIME_STATUS, runtimeState } from '../../shared/fleet-runtime-status.mjs'

// `awake` and `hibernating` are derived from an agent's runtime status. That
// status is assembled on the MAIN thread, so inside the store it was absent —
// and runtimeStatusForAgent falls back to HIBERNATING when it is absent. Every
// agent in here therefore read as hibernating, which inverted both words:
// addressing `awake` reached nobody and `hibernating` reached the whole fleet.
//
// Proven live before the fix, one minute apart, against an agent that had been
// awake all night: `chat(to: "awake & little-ui")` was refused, and
// `chat(to: "hibernating & little-ui")` delivered.

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
  store.recordRuntimeState('fleet:riser', runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.AWAKE), NOW)
  store.recordRuntimeState('fleet:sleeper', runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.HIBERNATING), NOW)
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
    // This is the half recordRuntimeState -> _syncAgentRegistry covers: the
    // labels now exist, and the index that carries them has to hear about a
    // status change the same way it hears about a labelling event.
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'awake & sleeper'), [])

    store.recordRuntimeState('fleet:sleeper', runtimeState(RUNTIME_KIND.AI, RUNTIME_STATUS.AWAKE), '2026-08-02T06:05:00.000Z')

    assert.deepEqual(recipients(store, 'awake & sleeper'), ['fleet:sleeper'])
    assert.deepEqual(recipients(store, 'hibernating & sleeper'), [])
    store.close?.()
  })
})

test('the status survives a store restart', async () => {
  await withStore(async dbPath => {
    let store = new FleetStore(dbPath)
    seed(store)
    store.close?.()

    store = new FleetStore(dbPath)
    assert.deepEqual(recipients(store, 'awake & riser'), ['fleet:riser'])
    assert.deepEqual(recipients(store, 'hibernating & riser'), [])
    store.close?.()
  })
})
