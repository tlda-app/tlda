// Delivery is a subscription matching, and nothing else.
//
// These tests exist because this design has been abandoned twice on a wrong
// diagnosis. Someone bound `my_labels` so that it asked "does the addressee
// share a label with me", every awake agent shared `awake` with every other
// awake agent, and one default subscription per agent became a fleet-wide
// wiretap. That was written down as "status labels make this a wiretap", the
// specified default was abandoned for `to:<id>`, then deleted as inert, then
// replaced by a floor hard-coded in JS.
//
// Skip's rule, which these tests encode: "Receive messages that go to fucking
// awake agents. That's reasonable. That doesn't mean receive messages that go
// to ANY awake agent. It means receive messages that go to ALL awake agents."
// Membership, not intersection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FleetStore } from './fleet-store.mjs'
import {
  DEFAULT_SUBSCRIPTION_QUERY,
  DEFAULT_SUBSCRIPTION_POLICY,
  mintSubscriptionsFor,
  subscriptionSetsFromDaemonConfig,
} from '../../shared/subscriptions.mjs'
import { decideSubscriptionDelivery } from '../../shared/inbox-attention.mjs'
import { parseFilter } from '../../shared/fleet-labels.mjs'

// A fleet of four: two reviewers, a goose, and a sender — all awake, so every
// pair of them shares the `awake` pseudo-label. That sharing is the trap.
async function withFleet(testFn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-subscription-default-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'))
    const now = new Date().toISOString()
    const agents = [
      { id: 'fleet:sender', friendly_name: 'sender', labels: [] },
      { id: 'fleet:alice', friendly_name: 'alice', labels: ['reviewers'] },
      { id: 'fleet:bob', friendly_name: 'bob', labels: ['reviewers'] },
      { id: 'fleet:goose', friendly_name: 'goose', labels: ['goose'] },
    ]
    for (const a of agents) await store.upsertAgent({ ...a, registered_at: now, last_seen: now })
    // Everyone holds the default, the way mint gives it to them.
    for (const a of agents) {
      store.ensureSubscription({
        owner: a.id,
        query: DEFAULT_SUBSCRIPTION_QUERY,
        notificationPolicy: DEFAULT_SUBSCRIPTION_POLICY,
      })
    }
    try { await testFn(store) } finally { store.close() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Who actually gets notified when `from` sends to the set named by `address`.
// Mirrors the server: resolve the address to recipients, then ask the matching
// layer for each one. Both halves are the real implementations.
function notifiedFor(store, from, address) {
  const recipients = store.resolveChatRecipients(parseFilter(address), { from, filter: address })
  const notified = new Set()
  for (const to of recipients) {
    for (const d of store.resolveSubscriptionDeliveries(from, to, 'chat')) notified.add(d.recipient)
  }
  return notified
}

test('a message to one agent does not reach another that merely shares `awake`', async () => {
  await withFleet(async store => {
    const notified = notifiedFor(store, 'fleet:sender', 'fleet:alice')
    assert.ok(notified.has('fleet:alice'), 'the addressee must be notified')
    assert.ok(!notified.has('fleet:bob'), 'sharing a status label with the addressee must not deliver')
    assert.ok(!notified.has('fleet:goose'))
  })
})

test('a message to a group reaches every member of that group', async () => {
  await withFleet(async store => {
    const notified = notifiedFor(store, 'fleet:sender', 'reviewers')
    assert.ok(notified.has('fleet:alice'))
    assert.ok(notified.has('fleet:bob'))
    assert.ok(!notified.has('fleet:goose'), 'a non-member must not receive a group message')
  })
})

test('a negation in the address excludes the agent it names', async () => {
  await withFleet(async store => {
    const included = notifiedFor(store, 'fleet:sender', 'reviewers | goose')
    assert.ok(included.has('fleet:goose'), 'control: goose is reachable when the address includes it')

    const excluded = notifiedFor(store, 'fleet:sender', '(reviewers | goose) & !goose')
    assert.ok(excluded.has('fleet:alice'))
    assert.ok(!excluded.has('fleet:goose'), 'an agent excluded by a negation must not be notified')
  })
})

test('the default classifies as a real notification, not a queued one', async () => {
  await withFleet(async store => {
    const [direct] = store.resolveSubscriptionDeliveries('fleet:sender', 'fleet:alice', 'chat').filter(d => d.direct)
    assert.ok(direct)
    assert.equal(direct.recipient, 'fleet:alice')
    const decision = decideSubscriptionDelivery({ policy: direct.notification_policy, priority: 'normal', now: Date.now() })
    assert.equal(decision.delivery, 'notified')
  })
})

test('an agent that unsubscribes receives nothing, and that is allowed', async () => {
  await withFleet(async store => {
    // "if someone wants to, like, have their agents be completely
    // unaddressable, that's their fucking choice." No floor puts it back.
    for (const row of store.getSubscriptionsByOwner('fleet:alice')) store.endSubscription(row.subscription_id)
    const notified = notifiedFor(store, 'fleet:sender', 'fleet:alice')
    assert.equal(notified.size, 0, 'with no subscription there is no delivery — nothing underneath restores one')
  })
})

test('a sender is not notified about its own message', async () => {
  await withFleet(async store => {
    const notified = notifiedFor(store, 'fleet:alice', 'reviewers')
    assert.ok(!notified.has('fleet:alice'))
    assert.ok(notified.has('fleet:bob'))
  })
})

test('subscribing twice does not accumulate rows', async () => {
  await withFleet(async store => {
    const before = store.getSubscriptionsByOwner('fleet:alice').length
    store.ensureSubscription({ owner: 'fleet:alice', query: DEFAULT_SUBSCRIPTION_QUERY })
    store.ensureSubscription({ owner: 'fleet:alice', query: DEFAULT_SUBSCRIPTION_QUERY })
    assert.equal(store.getSubscriptionsByOwner('fleet:alice').length, before)
  })
})

test('a dead subscription owner is not a resolvable delivery target', async () => {
  await withFleet(async store => {
    const now = new Date().toISOString()
    await store.upsertAgent({ id: 'fleet:alice', friendly_name: 'alice', labels: ['reviewers'], registered_at: now, last_seen: now, dead: true })

    const notified = notifiedFor(store, 'fleet:sender', 'fleet:alice')

    assert.ok(!notified.has('fleet:alice'))
  })
})

test('the one-time migration does not resurrect a deleted subscription', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-subscription-migration-'))
  try {
    const dbPath = join(dir, 'fleet.db')
    const now = new Date().toISOString()
    let store = new FleetStore(dbPath)
    await store.upsertAgent({ id: 'fleet:quiet', friendly_name: 'quiet', labels: [], registered_at: now, last_seen: now })
    store.close()

    // Second open: the migration has already run and recorded itself, so this
    // agent is not seeded by it. Give it the default the way mint would, then
    // delete it deliberately.
    store = new FleetStore(dbPath)
    store.ensureSubscription({ owner: 'fleet:quiet', query: DEFAULT_SUBSCRIPTION_QUERY })
    for (const row of store.getSubscriptionsByOwner('fleet:quiet')) store.endSubscription(row.subscription_id)
    assert.equal(store.getSubscriptionsByOwner('fleet:quiet').length, 0)
    store.close()

    // Restart. A reconcile-every-boot sweep would put it back; a migration that
    // records having run does not. That difference is the whole reason it is
    // keyed — otherwise it is the floor in a third costume.
    store = new FleetStore(dbPath)
    assert.equal(store.getSubscriptionsByOwner('fleet:quiet').length, 0, 'a deliberate unsubscribe must survive a restart')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('daemon.yaml sets are additive on top of the default, in { default, values } form', () => {
  const wanted = mintSubscriptionsFor({
    subscriptions: {
      default: 'standard',
      values: {
        standard: [{ query: 'incident', policy: 'immediate' }],
        quiet: [{ query: 'release', policy: 'batch(15m)' }],
      },
    },
  })
  assert.equal(wanted[0].query, 'to:me', 'direct mail leads')
  assert.deepEqual(wanted.map(w => w.query), ['to:me', DEFAULT_SUBSCRIPTION_QUERY, 'incident'])
  assert.ok(!wanted.some(w => w.query === 'release'), 'a set that is not the default grants nothing')
})

test('with no daemon config at all, an agent still asks for both mint slots', () => {
  assert.deepEqual(mintSubscriptionsFor({}).map(w => w.query), ['to:me', DEFAULT_SUBSCRIPTION_QUERY])
  assert.deepEqual(mintSubscriptionsFor(undefined).map(w => w.query), ['to:me', DEFAULT_SUBSCRIPTION_QUERY])
  assert.deepEqual(subscriptionSetsFromDaemonConfig({}), { defaultSet: null, sets: {} })
})
