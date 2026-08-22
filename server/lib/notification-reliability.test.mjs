// Two ways a notification silently did not happen. Both are the class AGENTS.md
// names as worth a test — dropped communication, failing quietly — and neither
// is visible from either end on its own.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import { parseFilter } from '../../shared/fleet-labels.mjs'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-notification-reliability-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'))
    const now = new Date().toISOString()
    for (const a of [
      { id: 'fleet:sender', friendly_name: 'sender', labels: [] },
      { id: 'fleet:alice', friendly_name: 'alice', labels: [] },
    ]) await store.upsertAgent({ ...a, registered_at: now, last_seen: now })
    for (const id of ['fleet:sender', 'fleet:alice']) {
      store.ensureSubscription({ owner: id, query: 'to:me', notificationPolicy: 'immediate', mandatory: true })
    }
    try { await fn(store) } finally { store.close() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const directMatches = (store) => store
  .resolveSubscriptionDeliveries('fleet:sender', 'fleet:alice', 'chat', parseFilter('fleet:alice'))
  .filter(d => d.direct)

// The resolvable-subscription cache answers a query joined against `agents ...
// dead = 0`, so a lifecycle change makes it wrong. Only subscription writes ever
// busted it. The fault is the INTERLEAVING, not the lifecycle change: the cache
// has to be rebuilt while the flag is in the other state. Run either sequence
// without that step and nothing goes wrong at all, which is why this was
// invisible and why it presented as intermittent.
//
// Both directions are broken, and they are two different bugs.
test('a reanimated agent is a delivery target again immediately', async () => {
  await withStore(store => {
    assert.equal(directMatches(store).length, 1, 'control: a live agent resolves its own subscription')

    store.markDead('fleet:alice')
    assert.equal(directMatches(store).length, 0, 'a dead agent is not a delivery target')

    store.markAlive('fleet:alice')
    assert.equal(directMatches(store).length, 1, 'reanimate must restore delivery without a second write')
  })
})

// The other direction, and the worse one. A dead agent resolving as a live
// delivery target is a message accepted for a recipient whose route cannot
// exist — AGENTS.md §"A mailbox is not proof of reachability". It is not a
// missed notification, it is mail that reports itself deliverable and can never
// be delivered, and nothing downstream can tell the difference.
//
// This needs its own test because the reanimate case above cannot catch it: it
// kills BEFORE the cache is rebuilt, so its `dead` assertion passes on a stale
// cache for the wrong reason.
test('a killed agent stops being a delivery target immediately', async () => {
  await withStore(store => {
    assert.equal(directMatches(store).length, 1, 'control: alive and resolvable, cache warm')
    store.markDead('fleet:alice')
    assert.equal(
      directMatches(store).length, 0,
      'a dead agent must not resolve as a delivery target — that is accepted mail to a route that cannot exist',
    )
  })
})

// An amend is the message its recipients are now reading. It could never be
// unread for anyone — the type was not in the unread-eligible set — so it never
// reached an inbox and there was nothing for a notification to point at.
test('an amend lands unread in its recipients inbox', async () => {
  await withStore(async store => {
    const orig = await store.insertEventRecord({
      type: 'chat', timestamp: new Date().toISOString(),
      from: 'fleet:sender', to: ['fleet:alice'], text: 'first',
    }, { notify: false })
    await store.markInboxRead?.('fleet:alice')

    const amend = await store.insertEventRecord({
      type: 'amend', timestamp: new Date().toISOString(),
      from: 'fleet:sender', to: ['fleet:alice'], text: 'the actual answer',
      metadata: { amends: orig.id }, unread: true,
    }, { notify: false })

    const pending = await store.isUnreadPending(amend.id, 'fleet:alice')
    assert.ok(pending, 'an amend must be unread for its recipient, or no notification can lead to it')
  })
})

// The one caller that amends for a reason other than a new body says so, and
// must stay silent: re-emitting the same text behind a materialized attachment
// is not a message arriving.
test('an amend that opts out stays read', async () => {
  await withStore(async store => {
    const orig = await store.insertEventRecord({
      type: 'chat', timestamp: new Date().toISOString(),
      from: 'fleet:sender', to: ['fleet:alice'], text: 'first',
    }, { notify: false })
    const amend = await store.insertEventRecord({
      type: 'amend', timestamp: new Date().toISOString(),
      from: 'fleet:sender', to: ['fleet:alice'], text: 'first',
      metadata: { amends: orig.id }, unread: false,
    }, { notify: false })

    assert.equal(await store.isUnreadPending(amend.id, 'fleet:alice'), false)
  })
})

// The remedy the mandatory-row delete trigger names. Before this there was no
// way to set a policy at all, so a mandatory row was not merely undeletable but
// unchangeable.
test('a mandatory subscription can be turned down to hold', async () => {
  await withStore(store => {
    const [row] = store.getSubscriptionsByOwner('fleet:alice').filter(r => r.query === 'to:me')
    assert.ok(row, 'control: the mandatory slot exists')
    assert.equal(row.mandatory, 1)
    assert.throws(() => store.endSubscription(row.subscription_id), /mandatory/)

    const updated = store.setSubscriptionPolicy(row.subscription_id, 'hold')
    assert.equal(updated.notification_policy, 'hold')
    assert.equal(directMatches(store).length, 1, 'it still matches — held, not deleted')
    assert.equal(directMatches(store)[0].notification_policy, 'hold', 'and the resolver sees the new policy')
  })
})
