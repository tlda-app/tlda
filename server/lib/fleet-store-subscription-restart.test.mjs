import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'

async function withStore(testFn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-subscription-restart-'))
  const dbPath = join(dir, 'fleet.db')
  try {
    await testFn(dbPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('explicit self-subscription survives store restart', async () => {
  await withStore(async dbPath => {
    let store = new FleetStore(dbPath)
    const owner = 'fleet:explicit-self'
    const tap = store.addWiretap(owner, `to:${owner}`, null)
    const subscription = store.addSubscription({
      owner,
      query: `to:${owner}`,
      notificationPolicy: 'immediate',
      createdBy: owner,
      adapter: 'wiretap',
      adapterId: tap.id,
    })
    store.close()

    store = new FleetStore(dbPath)
    assert.equal(store.getSubscription(subscription.subscription_id)?.adapter_id, tap.id)
    assert.equal(store.getWiretapsByAgent(owner).some(row => row.id === tap.id), true)
    store.close()
  })
})

test('restart cannot orphan an explicit subscription sharing an adapter', async () => {
  await withStore(async dbPath => {
    let store = new FleetStore(dbPath)
    const tap = store.addWiretap('fleet:shared-owner', 'to:reviewers', null)
    const first = store.addSubscription({
      owner: 'fleet:shared-owner',
      query: 'to:reviewers',
      notificationPolicy: 'immediate',
      createdBy: 'fleet:shared-owner',
      adapter: 'wiretap',
      adapterId: tap.id,
    })
    const second = store.addSubscription({
      owner: 'fleet:explicit-reader',
      query: 'to:reviewers',
      notificationPolicy: 'immediate',
      createdBy: 'fleet:explicit-reader',
      adapter: 'wiretap',
      adapterId: tap.id,
    })
    store.close()

    store = new FleetStore(dbPath)
    assert.equal(store.getSubscription(first.subscription_id)?.adapter_id, tap.id)
    assert.equal(store.getSubscription(second.subscription_id)?.adapter_id, tap.id)
    assert.equal(store.getWiretaps().some(row => row.id === tap.id), true)
    store.close()
  })
})
