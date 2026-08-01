import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import { decideSubscriptionDelivery } from '../../shared/inbox-attention.mjs'
import { DEFAULT_SUBSCRIPTION_QUERY } from '../../shared/subscriptions.mjs'

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

test('subscription deliveries retain notification policy and bypass raw wiretap fanout', async () => {
  await withStore(async dbPath => {
    const store = new FleetStore(dbPath, { taskDoc: false })
    const now = new Date().toISOString()
    await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
    await store.upsertAgent({ id: 'fleet:target', friendly_name: 'target', labels: ['reviewers'], registered_at: now, last_seen: now })
    await store.upsertAgent({ id: 'fleet:subscriber', friendly_name: 'subscriber', labels: [], registered_at: now, last_seen: now })

    // Mint gives the addressee its default first; the observer subscribes after.
    const target = store.ensureSubscription({ owner: 'fleet:target', query: DEFAULT_SUBSCRIPTION_QUERY })
    const tap = store.addWiretap('fleet:subscriber', 'to:reviewers', null)
    const observer = store.addSubscription({
      owner: 'fleet:subscriber',
      query: 'to:reviewers',
      notificationPolicy: 'batch(30s)',
      createdBy: 'fleet:subscriber',
      adapter: 'wiretap',
      adapterId: tap.id,
    })

    assert.deepEqual(store.resolveWiretaps('fleet:sender', 'fleet:target', 'chat'), [])
    // Both deliveries are rows now — the addressee's own default and the
    // observer's `to:reviewers`. Neither is synthesised, and `direct` is simply
    // which of them belongs to the agent the message was addressed to.
    assert.deepEqual(store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:target', 'chat'), [{
      recipient: 'fleet:target',
      subscription_id: target.subscription_id,
      query: DEFAULT_SUBSCRIPTION_QUERY,
      notification_policy: 'immediate',
      origin: 'held',
      direct: true,
    }, {
      recipient: 'fleet:subscriber',
      subscription_id: observer.subscription_id,
      query: 'to:reviewers',
      notification_policy: 'batch(30s)',
      origin: 'held',
      direct: false,
    }])
    store.close()
  })
})

test('subscription notification policy controls delivery and urgent pierces it', () => {
  const now = Date.parse('2026-07-29T07:00:00.000Z')

  assert.deepEqual(decideSubscriptionDelivery({ policy: 'immediate', priority: 'normal', now }), {
    delivery: 'notified',
    wokeRecipient: 'yes',
    notifyBy: null,
  })
  assert.deepEqual(decideSubscriptionDelivery({ policy: 'hold', priority: 'normal', now }), {
    delivery: 'queued',
    wokeRecipient: 'no',
    notifyBy: null,
  })
  assert.deepEqual(decideSubscriptionDelivery({ policy: 'batch(30s)', priority: 'normal', now }), {
    delivery: 'batched',
    wokeRecipient: 'not_yet',
    notifyBy: '2026-07-29T07:00:30.000Z',
  })
  assert.deepEqual(decideSubscriptionDelivery({ policy: 'hold', priority: 'urgent', now }), {
    delivery: 'notified',
    wokeRecipient: 'yes',
    notifyBy: null,
  })
  assert.deepEqual(decideSubscriptionDelivery({ policy: 'batch(30s)', priority: 'urgent', now }), {
    delivery: 'notified',
    wokeRecipient: 'yes',
    notifyBy: null,
  })
})
