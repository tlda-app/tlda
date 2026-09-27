import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import { parseFilter } from '../../shared/fleet-labels.mjs'

// Direct-name resolution falls back to a dead sole holder; filter-fan keeps
// excluding dead. Death stops delivery, not addressing.

async function withStore(testFn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-dead-singleton-'))
  try {
    await testFn(join(dir, 'fleet.db'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const NOW = '2026-08-02T06:00:00.000Z'

function seed(store) {
  store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: NOW, last_seen: NOW })
  store.upsertAgent({ id: 'fleet:doomed', friendly_name: 'doomed', labels: [], registered_at: NOW, last_seen: NOW })
  store.upsertAgent({ id: 'fleet:twindead', friendly_name: 'twin', labels: [], registered_at: NOW, last_seen: NOW })
  store.markDead('fleet:twindead')
  store.upsertAgent({ id: 'fleet:twinlive', friendly_name: 'twin', labels: [], registered_at: NOW, last_seen: NOW })
  store.upsertAgent({ id: 'fleet:tagged', friendly_name: 'tagged', labels: ['crew'], registered_at: NOW, last_seen: NOW })
  store.markDead('fleet:doomed')
  store.markDead('fleet:tagged')
}

function recipients(store, expression) {
  return store.resolveChatRecipients(parseFilter(expression), {
    from: 'fleet:sender',
    filter: expression,
  })
}

test('a dead sole holder is addressed by name', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'doomed'), ['fleet:doomed'])
    store.close?.()
  })
})

test('a dead sole holder is addressed by fleet:id', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'fleet:doomed'), ['fleet:doomed'])
    store.close?.()
  })
})

test('a dead twin sharing a live name does not double-fan', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'twin'), ['fleet:twinlive'])
    store.close?.()
  })
})

test('an unknown name still resolves empty', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'no-such-agent'), [])
    store.close?.()
  })
})

test('a label held only by dead agents resolves empty', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'crew'), [])
    store.close?.()
  })
})

test('a filter expression keeps excluding dead', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath)
    seed(store)
    assert.deepEqual(recipients(store, 'crew | doomed'), [])
    store.close?.()
  })
})
