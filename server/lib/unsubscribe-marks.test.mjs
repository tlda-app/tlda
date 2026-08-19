// Unsubscribing marks the row. It does not remove it.
//
// Skip, 2026-08-19 05:40 EDT, asked what happens to the row when someone
// unsubscribes: "Oh, that's interesting. Yeah. Unsubscribing should mark".
//
// The whole risk of that change lives in the read paths. A marked row that some
// query still returns is a subscription that was cancelled and still delivers;
// a marked row that some query still counts is a suppression that never lifts.
// Both are silent -- nothing errors, nothing logs, and the only symptom is
// delivery that is wrong in a direction nobody is watching. That is the class
// AGENTS.md says to test for, so these are the tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'

async function withStore(testFn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-unsubscribe-marks-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'))
    const now = new Date().toISOString()
    for (const id of ['fleet:alice', 'fleet:bob', 'fleet:carol']) {
      await store.upsertAgent({
        id, friendly_name: id.split(':')[1], labels: [], registered_at: now, last_seen: now, dead: false,
      })
    }
    try { await testFn(store) } finally { store.close() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('an ended subscription is gone from every read, and its row is still there', async () => {
  await withStore(async (store) => {
    const sub = await store.addSubscription({
      owner: 'fleet:alice', query: 'to:me', notificationPolicy: 'now',
      createdBy: 'fleet:alice', adapter: 'subscription',
    })

    assert.equal((await store.getSubscriptionsByOwner('fleet:alice')).length, 1)
    assert.ok(await store.getSubscription(sub.subscription_id))
    assert.equal((await store.getSubscriptionsByOwners(['fleet:alice']))['fleet:alice'].length, 1)

    assert.equal(await store.endSubscription(sub.subscription_id), true)

    // Every read path, not just the one the caller happened to use.
    assert.deepEqual(await store.getSubscriptionsByOwner('fleet:alice'), [])
    assert.equal(await store.getSubscription(sub.subscription_id), null)
    assert.deepEqual(await store.getSubscriptionsByAdapter('subscription'), [])
    assert.deepEqual((await store.getSubscriptionsByOwners(['fleet:alice']))['fleet:alice'], undefined)

    // ...and the record survives, which is the entire point of marking.
    const row = store.db
      .prepare('SELECT owner, query, notification_policy, ended_at FROM subscriptions WHERE subscription_id = ?')
      .get(sub.subscription_id)
    assert.equal(row.owner, 'fleet:alice')
    assert.equal(row.query, 'to:me')
    assert.equal(row.notification_policy, 'now')
    assert.ok(row.ended_at, 'ended_at is stamped')
  })
})

test('ending is idempotent and does not overwrite when it happened', async () => {
  await withStore(async (store) => {
    const sub = await store.addSubscription({
      owner: 'fleet:alice', query: 'to:me', notificationPolicy: 'now',
      createdBy: 'fleet:alice', adapter: 'subscription',
    })
    assert.equal(await store.endSubscription(sub.subscription_id, '2026-08-19T05:00:00.000Z'), true)
    assert.equal(await store.endSubscription(sub.subscription_id, '2026-08-19T06:00:00.000Z'), false)
    const row = store.db.prepare('SELECT ended_at FROM subscriptions WHERE subscription_id = ?').get(sub.subscription_id)
    assert.equal(row.ended_at, '2026-08-19T05:00:00.000Z', 'the first ending is the one on the record')
  })
})

test('re-subscribing after ending is a second row, and the first still reads as ended', async () => {
  await withStore(async (store) => {
    const first = await store.addSubscription({
      owner: 'fleet:alice', query: 'to:me', notificationPolicy: 'now',
      createdBy: 'fleet:alice', adapter: 'subscription',
    })
    await store.endSubscription(first.subscription_id)
    const second = await store.addSubscription({
      owner: 'fleet:alice', query: 'to:me', notificationPolicy: 'now',
      createdBy: 'fleet:alice', adapter: 'subscription',
    })

    assert.notEqual(second.subscription_id, first.subscription_id)
    // One live row, not two, and not zero.
    const live = await store.getSubscriptionsByOwner('fleet:alice')
    assert.equal(live.length, 1)
    assert.equal(live[0].subscription_id, second.subscription_id)
    // Two rows on the record: the span that ended and the span that is open.
    const all = store.db.prepare('SELECT ended_at FROM subscriptions WHERE owner = ? ORDER BY subscription_id').all('fleet:alice')
    assert.equal(all.length, 2)
    assert.ok(all[0].ended_at)
    assert.equal(all[1].ended_at, null)
  })
})

// The subtle one. `_getResolvableWiretaps` suppresses any wiretap that a
// subscription adapts, so that the same filter does not deliver twice. If that
// suppression list keeps counting ended subscriptions, ending one silently
// stops the wiretap it adapted from ever resolving again -- delivery lost, with
// nothing to see.
test('ending a subscription stops suppressing the wiretap it adapted', async () => {
  await withStore(async (store) => {
    const { id: wiretapId } = await store.addWiretap('fleet:alice', 'from:bob')
    const sub = await store.addSubscription({
      owner: 'fleet:alice', query: 'from:bob', notificationPolicy: 'now',
      createdBy: 'fleet:alice', adapter: 'wiretap', adapterId: wiretapId,
    })

    // Asserted against the suppression query itself. Going through
    // resolveWiretaps() cannot show this in one process: addSubscription busts
    // _resolvableSubscriptionWiretapCache and not _resolvableWiretapCache, so
    // that path answers from a cache the subscription never invalidated. That
    // gap predates this change and is unaffected by it -- a deleted row and a
    // marked row are equally invisible to a stale cache -- but it means the
    // honest place to check the suppression is where the suppression is.
    const resolvable = () => store._getResolvableWiretaps.all().map(r => r.id)

    assert.equal(resolvable().includes(wiretapId), false,
      'while the subscription is live the wiretap it adapts is suppressed')

    await store.endSubscription(sub.subscription_id)

    assert.equal(resolvable().includes(wiretapId), true,
      'an ended subscription must not go on suppressing the wiretap')
  })
})

test('an ended wiretap stops matching and keeps its filter', async () => {
  await withStore(async (store) => {
    const { id } = await store.addWiretap('fleet:alice', 'from:bob')
    assert.equal((await store.getWiretapsByAgent('fleet:alice')).length, 1)

    assert.equal(await store.endWiretap(id), true)

    assert.deepEqual(await store.getWiretapsByAgent('fleet:alice'), [])
    assert.equal((await store.getWiretaps()).some(w => w.id === id), false)
    assert.equal(store._getResolvableWiretaps.all().some(r => r.id === id), false)

    const row = store.db.prepare('SELECT filter, ended_at FROM wiretaps WHERE id = ?').get(id)
    assert.ok(row.filter, 'the filter expression survives -- it has no other copy anywhere')
    assert.ok(row.ended_at)
  })
})

// The delete trigger guarding mandatory subscriptions is now on a path nobody
// takes. On its own it would keep passing while protecting nothing.
test('a mandatory subscription cannot be ended either', async () => {
  await withStore(async (store) => {
    const sub = await store.addSubscription({
      owner: 'fleet:alice', query: 'to:me', notificationPolicy: 'now',
      createdBy: 'fleet:alice', adapter: 'subscription', mandatory: true,
    })
    await assert.rejects(
      async () => store.endSubscription(sub.subscription_id),
      /mandatory subscription cannot be removed/,
    )
    assert.equal((await store.getSubscriptionsByOwner('fleet:alice')).length, 1)
  })
})
