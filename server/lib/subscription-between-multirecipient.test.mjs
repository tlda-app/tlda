// `<>` must keep working when a message has more than one recipient.
//
// resolveSubscriptionDeliveries built its recipient label set as
// `recipientIds.length === 1 ? labels : []`. `<>` is the only operator that
// reads that set -- every other one reads `to`, which falls back to the
// envelope -- so the empty branch disabled exactly one operator, silently: an
// empty set makes both disjuncts of `between` false, which is indistinguishable
// from a genuine non-match. Three subscriptions went silent across 16 events
// while `to:me` delivered for the same seat.
//
// These assert the evaluator directly, which is where the decision is made.
// `to:me` is the control: it must be true under both recipient shapes, so a
// failure here names the operator rather than the fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { evalExprDirectional } from '../../shared/fleet-labels.mjs'
import { parseUnifiedFilter } from '../../shared/unified-filter-grammar.mjs'

const SUBSCRIBER = ['watcher', 'fleet:watch01']
const SENDER = ['skip', 'fleet:skip', 'human', 'awake']
const OTHER = ['someone-else', 'fleet:other9', 'awake']

const between = parseUnifiedFilter('me <> skip', { sort: 'message' })
const toMe = parseUnifiedFilter('to:me', { sort: 'message' })

// The envelope is what the message was addressed to; the label set is the
// recipients' own labels. Both are present in live delivery.
const ctx = toLabels => ({
  fromLabels: SENDER,
  toLabels,
  subscriberLabels: [],
  subscriberIdentity: SUBSCRIBER,
  envelope: new Set(['watcher', 'fleet:watch01']),
})

test('`<>` matches when the subscriber is the only recipient', () => {
  assert.equal(evalExprDirectional(between, ctx([...SUBSCRIBER, 'awake'])), true)
})

test('`<>` still matches when the message has a second recipient', () => {
  // The union of both recipients' labels. Under the old ternary this argument
  // was [] and this assertion is the one that failed.
  assert.equal(evalExprDirectional(between, ctx([...SUBSCRIBER, 'awake', ...OTHER])), true)
})

test('`<>` does not match a two-recipient message the subscriber is not on', () => {
  // The union cannot over-match: absent from every recipient's labels means
  // absent from their union.
  assert.equal(evalExprDirectional(between, ctx([...OTHER, 'third-agent', 'fleet:third1'])), false)
})

test('to:me is unaffected by recipient count — the control', () => {
  assert.equal(evalExprDirectional(toMe, ctx([...SUBSCRIBER, 'awake'])), true)
  assert.equal(evalExprDirectional(toMe, ctx([...SUBSCRIBER, 'awake', ...OTHER])), true)
})

// The empty set is the exact shape the old code produced, and it is worth
// pinning on its own: it is why the failure was silent rather than an error.
test('an empty recipient label set makes `<>` unmatchable, which is the defect', () => {
  assert.equal(evalExprDirectional(between, ctx([])), false)
  assert.equal(evalExprDirectional(toMe, ctx([])), true)
})

// The tests above assert the evaluator. They pass a label set in directly, so
// they cannot fail on the line that BUILDS that set -- which is the line the
// defect was in. This one runs resolveSubscriptionDeliveries itself, with a real
// store and a real subscription, and is the one that goes red on a revert.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from './fleet-store.mjs'
import { parseFilter } from '../../shared/fleet-labels.mjs'

async function withFleet(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-between-multi-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'))
    const now = new Date().toISOString()
    for (const a of [
      { id: 'fleet:skip', friendly_name: 'skip', labels: [] },
      { id: 'fleet:watcher', friendly_name: 'watcher', labels: [] },
      { id: 'fleet:other', friendly_name: 'other', labels: [] },
    ]) await store.upsertAgent({ ...a, registered_at: now, last_seen: now })
    store.ensureSubscription({ owner: 'fleet:watcher', query: 'me <> skip', notificationPolicy: 'now' })
    try { await fn(store) } finally { store.close() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const delivered = (store, recipients, address) =>
  store.resolveSubscriptionDeliveries('fleet:skip', recipients, 'chat', parseFilter(address))
    .map(d => d.recipient)

test('store: a `<>` subscription is delivered on a single-recipient message', async () => {
  await withFleet(store => {
    assert.ok(delivered(store, 'fleet:watcher', 'watcher').includes('fleet:watcher'))
  })
})

test('store: a `<>` subscription survives a second recipient on the message', async () => {
  await withFleet(store => {
    const got = delivered(store, ['fleet:watcher', 'fleet:other'], 'watcher | other')
    assert.ok(got.includes('fleet:watcher'), `watcher was not notified; got ${JSON.stringify(got)}`)
  })
})

test('store: `<>` is not delivered to someone the message is not between', async () => {
  await withFleet(store => {
    const got = delivered(store, ['fleet:other'], 'other')
    assert.ok(!got.includes('fleet:watcher'), `watcher over-matched; got ${JSON.stringify(got)}`)
  })
})
