// The floor is the invariant that makes an unreachable agent unrepresentable.
// Once chat delivery resolves through subscriptions, an agent that matches
// nothing is not notified — and it does not error, does not change the sender's
// receipt, and does not appear anywhere. That is exactly the failure of
// 2026-08-01, which ran eighteen hours unnoticed. These tests exist so it
// cannot come back through a missing row or an absent config file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import { floorSubscription, grantedSubscriptionsFor, subscriptionSetsFromDaemonConfig } from '../../shared/subscriptions.mjs'
import { decideSubscriptionDelivery } from '../../shared/inbox-attention.mjs'

async function withStore(testFn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-subscription-floor-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'))
    const now = new Date().toISOString()
    await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
    await store.upsertAgent({ id: 'fleet:target', friendly_name: 'target', labels: [], registered_at: now, last_seen: now })
    try { await testFn(store) } finally { store.close() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const directOf = (deliveries) => deliveries.find(d => d.direct)

test('a recipient with no subscriptions at all is still delivered to', async () => {
  await withStore(async store => {
    // The whole database has no subscriptions and no wiretaps. Before the floor
    // this returned [] and the recipient would simply never be woken.
    const deliveries = store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:target', 'chat')
    const direct = directOf(deliveries)
    assert.ok(direct, 'every living recipient must resolve a direct delivery')
    assert.equal(direct.recipient, 'fleet:target')
    assert.equal(direct.notification_policy, 'immediate')
    assert.equal(direct.origin, 'floor')
  })
})

test('the floor survives the classifier as a real notification', async () => {
  await withStore(async store => {
    const direct = directOf(store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:target', 'chat'))
    const decision = decideSubscriptionDelivery({ policy: direct.notification_policy, priority: 'normal', now: Date.now() })
    assert.equal(decision.delivery, 'notified', 'the floor must classify as notified, not queued or batched')
  })
})

test("an agent's own subscription cannot quiet its direct mail", async () => {
  await withStore(async store => {
    // Explicitly try to downgrade your own delivery to `hold`.
    const tap = store.addWiretap('fleet:target', 'to:fleet:target', null)
    store.addSubscription({
      owner: 'fleet:target',
      query: 'to:fleet:target',
      notificationPolicy: 'hold',
      createdBy: 'fleet:target',
      adapter: 'wiretap',
      adapterId: tap.id,
    })
    const deliveries = store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:target', 'chat')
    const direct = directOf(deliveries)
    assert.equal(direct.notification_policy, 'immediate', 'the floor wins; you can add subscriptions, not remove this one')
    assert.equal(deliveries.filter(d => d.recipient === 'fleet:target').length, 1,
      'the held row folds into the floor rather than producing a second delivery')
  })
})

test('a sender is not notified about its own message', async () => {
  await withStore(async store => {
    const tap = store.addWiretap('fleet:sender', 'to:fleet:target', null)
    store.addSubscription({
      owner: 'fleet:sender', query: 'to:fleet:target', notificationPolicy: 'immediate',
      createdBy: 'fleet:sender', adapter: 'wiretap', adapterId: tap.id,
    })
    const deliveries = store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:target', 'chat')
    assert.equal(deliveries.some(d => d.recipient === 'fleet:sender'), false)
  })
})

test('observers still resolve alongside the floor, and are not direct', async () => {
  await withStore(async store => {
    const now = new Date().toISOString()
    await store.upsertAgent({ id: 'fleet:watcher', friendly_name: 'watcher', labels: [], registered_at: now, last_seen: now })
    const tap = store.addWiretap('fleet:watcher', 'to:fleet:target', null)
    store.addSubscription({
      owner: 'fleet:watcher', query: 'to:fleet:target', notificationPolicy: 'batch(30s)',
      createdBy: 'fleet:watcher', adapter: 'wiretap', adapterId: tap.id,
    })
    const deliveries = store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:target', 'chat')
    const watcher = deliveries.find(d => d.recipient === 'fleet:watcher')
    assert.ok(watcher)
    assert.equal(watcher.direct, false)
    assert.equal(watcher.notification_policy, 'batch(30s)')
    assert.ok(directOf(deliveries), 'the recipient is still delivered to')
  })
})

// --------------------------------------------------------------------------
// The config half. The server that decides delivery runs on Fly, which has no
// daemon.yaml — readYamlFile returns {} for a missing file, silently. So the
// no-config case is production, not an edge case.
// --------------------------------------------------------------------------

test('with no daemon config at all, an agent still holds the floor', () => {
  for (const [label, config] of [['undefined', undefined], ['empty (Fly)', {}], ['null', null]]) {
    const granted = grantedSubscriptionsFor('fleet:x', config)
    assert.equal(granted.length, 1, `${label}: exactly the floor`)
    assert.deepEqual(granted[0], floorSubscription('fleet:x'))
    assert.equal(granted[0].notification_policy, 'immediate')
  }
})

test('a declared default set is additive on top of the floor', () => {
  const granted = grantedSubscriptionsFor('fleet:x', {
    subscriptions: {
      default: 'core',
      values: { core: ['from:skip', { query: 'to:reviewers', policy: 'batch(15s)' }] },
    },
  })
  assert.equal(granted[0].origin, 'floor', 'the floor always leads')
  assert.deepEqual(granted.slice(1).map(g => [g.query, g.notification_policy, g.origin, g.set]), [
    ['from:skip', 'immediate', 'granted', 'core'],
    ['to:reviewers', 'batch(15s)', 'granted', 'core'],
  ])
})

test('a set that is not the default grants nothing', () => {
  const granted = grantedSubscriptionsFor('fleet:x', {
    subscriptions: { default: 'core', values: { core: [], other: ['from:skip'] } },
  })
  assert.equal(granted.length, 1, 'only the floor; `other` is declared but not default')
})

test('subscription sets parse in the { default, values } form', () => {
  const { defaultSet, sets } = subscriptionSetsFromDaemonConfig({
    subscriptions: { default: 'core', values: { core: ['from:skip'] } },
  })
  assert.equal(defaultSet, 'core')
  assert.deepEqual(sets.core, [{ query: 'from:skip', notification_policy: 'immediate' }])
  assert.deepEqual(subscriptionSetsFromDaemonConfig({}), { defaultSet: null, sets: {} })
})
