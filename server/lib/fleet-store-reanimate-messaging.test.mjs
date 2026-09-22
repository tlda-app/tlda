// Death ends every subscription including the mandatory `to:me` slot; a
// reanimated agent must be addressable again without anyone re-adding rows by
// hand. Measured 2026-09-21: a reanimated PM had zero live subscriptions, so
// chat to it resolved no direct match and the send path crashed dereferencing
// a null deliveryDecision instead of recording `no_direct_subscription`.
//
// Two halves, matching the two halves of the fix:
// 1. `markAlive` reseeds the mandatory direct slot (`to:me`, immediate).
// 2. A subscription-less recipient never crashes the send path — the delivery
//    layer reports `no_direct_subscription`, which is what the entry already
//    carries when deliveryDecision is null.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from './fleet-store.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-reanimate-messaging-'))
  const store = new FleetStore(join(dir, 'fleet.db'))
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('death then markAlive restores the mandatory direct slot and delivers', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender' })
    store.upsertAgent({ id: 'fleet:revived', friendly_name: 'revived' })
    store.ensureSubscription({
      owner: 'fleet:revived', query: 'to:me',
      notificationPolicy: 'immediate', mandatory: true,
    })

    // Positive control: the slot delivers before death.
    assert.ok(
      store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:revived', 'chat')
        .some(m => m.direct && m.query === 'to:me'),
      'direct slot delivers before death',
    )

    store.markDead('fleet:revived')
    assert.equal(store.getSubscriptionsByOwner('fleet:revived').length, 0,
      'death ends the direct slot — without this the test below passes on the old row')

    store.markAlive('fleet:revived')

    const live = store.getSubscriptionsByOwner('fleet:revived')
    assert.equal(live.length, 1, 'reanimate restores exactly the direct slot, not the group one')
    assert.equal(live[0].query, 'to:me')
    assert.equal(live[0].notification_policy, 'immediate')

    assert.ok(
      store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:revived', 'chat')
        .some(m => m.direct && m.query === 'to:me'),
      'addressed chat resolves a direct delivery after reanimate',
    )
  } finally {
    cleanup()
  }
})

test('markAlive preserves death semantics and a living agent keeps its group slot', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:revived', friendly_name: 'revived' })
    store.ensureSubscription({
      owner: 'fleet:revived', query: 'to:me',
      notificationPolicy: 'immediate', mandatory: true,
    })
    store.ensureSubscription({
      owner: 'fleet:revived', query: 'to:my_labels',
      notificationPolicy: 'immediate', mandatory: true,
    })

    store.markDead('fleet:revived')
    assert.equal(store.getSubscriptionsByOwner('fleet:revived').length, 0,
      'death still ends every subscription including the group slot')

    store.markAlive('fleet:revived')
    const queries = store.getSubscriptionsByOwner('fleet:revived').map(r => r.query)
    assert.deepEqual(queries, ['to:me'],
      'reanimate restores only the mandatory direct slot; group policy stays the owner\'s choice')

    // markAlive on a living agent is a no-op, not a reconcile: an agent that
    // deliberately dropped its direct slot keeps that choice.
    store.upsertAgent({ id: 'fleet:quiet', friendly_name: 'quiet' })
    assert.deepEqual(store.getSubscriptionsByOwner('fleet:quiet').map(r => r.query), [],
      'a living agent starts with no slots — control that the reseed below comes from markAlive, not mint')
    assert.equal(store.markAlive('fleet:quiet').id, 'fleet:quiet')
    assert.deepEqual(store.getSubscriptionsByOwner('fleet:quiet').map(r => r.query), [],
      'markAlive on a living agent adds nothing')
  } finally {
    cleanup()
  }
})

test('a subscription-less recipient resolves no direct delivery', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender' })
    store.upsertAgent({ id: 'fleet:silent', friendly_name: 'silent' })
    assert.deepEqual(store.getSubscriptionsByOwner('fleet:silent'), [],
      'control: the recipient genuinely holds no subscription')

    const matches = store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:silent', 'chat')
    assert.deepEqual(matches.filter(m => m.direct), [],
      'no direct match — the send path must record no_direct_subscription, not throw')
  } finally {
    cleanup()
  }
})
