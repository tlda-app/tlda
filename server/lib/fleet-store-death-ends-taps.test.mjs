// A dead agent's wiretaps and subscriptions end with it.
//
// `resolveWiretaps` walks every live tap on the main thread for every event, so
// a tap belonging to an agent that will never read it is paid for on every
// message the fleet sends. On live, 2026-09-12: 20,843 live wiretaps and
// 130,380 live subscriptions against 61,302 agents, none ever ended.
//
// This test fails against the old `markDead`, which left both behind.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from './fleet-store.mjs'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-death-taps-'))
  const store = new FleetStore(join(dir, 'fleet.db'))
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('killing an agent ends its wiretaps and its subscriptions', () => {
  const { store, cleanup } = freshStore()
  try {
    store.upsertAgent({ id: 'fleet:doomed', friendly_name: 'doomed' })
    store.upsertAgent({ id: 'fleet:survivor', friendly_name: 'survivor' })

    store.addWiretap('fleet:doomed', 'to:survivor', null)
    store.addWiretap('fleet:survivor', 'to:doomed', null)
    store.addSubscription({
      owner: 'fleet:doomed', query: 'from:survivor',
      notificationPolicy: 'now', createdBy: 'fleet:doomed', adapter: 'test',
    })
    store.addSubscription({
      owner: 'fleet:survivor', query: 'from:doomed',
      notificationPolicy: 'now', createdBy: 'fleet:survivor', adapter: 'test',
    })

    // Positive control: both agents' rows are live before the kill, so a green
    // result below cannot come from them never having existed.
    assert.equal(store.getWiretapsByAgent('fleet:doomed').length, 1, 'doomed starts with a live tap')
    assert.equal(store.getSubscriptionsByOwner('fleet:doomed').length, 1, 'doomed starts with a live subscription')

    store.markDead('fleet:doomed')

    assert.equal(store.getWiretapsByAgent('fleet:doomed').length, 0,
      'a dead agent keeps no live wiretap — resolveWiretaps walks it on every event')
    assert.equal(store.getSubscriptionsByOwner('fleet:doomed').length, 0,
      'a dead agent keeps no live subscription')

    // The kill is scoped to the agent that died. A neighbour losing its
    // subscriptions is silent delivery loss, which is worse than the leak.
    assert.equal(store.getWiretapsByAgent('fleet:survivor').length, 1,
      'a living agent keeps its wiretap')
    assert.equal(store.getSubscriptionsByOwner('fleet:survivor').length, 1,
      'a living agent keeps its subscription')
  } finally {
    cleanup()
  }
})
