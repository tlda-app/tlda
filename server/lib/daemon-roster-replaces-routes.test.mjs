// A daemon's roster replaces its routing picture, and replacing is the point.
//
// `setAgentDaemonRoute` can only add. One message says "this agent is here" and
// nothing can say "and nobody else is", so a route for an agent that died or
// moved survived until its agent row was deleted by `removeAgent()`, which was
// then the only caller of the route delete. That function is gone -- nothing
// deletes an agent row any more -- so this replace is now the only thing that
// can retire a stale route at all. Measured 2026-08-18: the
// daemon republished one `agent-route` per agent on every roster change and
// every reconnect, 8,532 messages in 5h40m against ~200/day of real mints, and
// none of them could remove anything.
//
// The risk this file guards is the one that makes the cure worse than the
// disease: a replace that is scoped wrongly deletes routes that are current, and
// a missing route is a husk -- an agent that exists, cannot be woken, and
// accepts mail it can never read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { FleetStore } from './fleet-store.mjs'
import { FLEET_STORE_METHODS } from './fleet-store-methods.mjs'

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'roster-routes-'))
  return new FleetStore(join(dir, 'fleet.db'))
}

function seed(s, id, daemonKey) {
  s.upsertAgent({ id, friendly_name: id.replace('fleet:', ''), registered_at: new Date().toISOString(), dead: 0 })
  s.setAgentDaemonRoute(id, daemonKey)
}

test('a roster removes a route the per-agent message could never remove', () => {
  const s = store()
  seed(s, 'fleet:a', 'mini:testing')
  seed(s, 'fleet:b', 'mini:testing')

  // 'b' is gone from the daemon's set. Under the old scheme nothing said so.
  const result = s.replaceAgentDaemonRoutes('mini:testing', ['fleet:a'])

  assert.equal(s.getAgentDaemonRoute('fleet:a')?.daemon_key, 'mini:testing')
  assert.ok(!s.getAgentDaemonRoute('fleet:b'), 'a dropped agent must lose its route')
  assert.deepEqual({ kept: result.kept, removed: result.removed }, { kept: 1, removed: 1 })
})

test('a roster does not touch another daemon\'s routes', () => {
  // The scoping that stops this being a route-loss bug. An agent that MOVED
  // already carries the new daemon's key, so the daemon it left must not delete
  // it when its own roster omits it.
  const s = store()
  seed(s, 'fleet:moved', 'mini:testing')
  seed(s, 'fleet:elsewhere', 'air:testing')

  s.replaceAgentDaemonRoutes('air:testing', ['fleet:elsewhere', 'fleet:moved'])
  assert.equal(s.getAgentDaemonRoute('fleet:moved')?.daemon_key, 'air:testing', 'the move lands')

  // The old daemon now reports its set, which no longer includes the mover.
  s.replaceAgentDaemonRoutes('mini:testing', [])

  assert.equal(s.getAgentDaemonRoute('fleet:moved')?.daemon_key, 'air:testing',
    'the old daemon must not delete a route the new daemon owns')
  assert.equal(s.getAgentDaemonRoute('fleet:elsewhere')?.daemon_key, 'air:testing')
})

test('an empty roster clears that daemon and only that daemon', () => {
  const s = store()
  seed(s, 'fleet:a', 'mini:testing')
  seed(s, 'fleet:c', 'air:testing')

  const result = s.replaceAgentDaemonRoutes('mini:testing', [])

  assert.ok(!s.getAgentDaemonRoute('fleet:a'))
  assert.equal(s.getAgentDaemonRoute('fleet:c')?.daemon_key, 'air:testing')
  assert.deepEqual({ kept: result.kept, removed: result.removed }, { kept: 0, removed: 1 })
})

test('a repeated roster is idempotent and reports no removals', () => {
  // The steady state. A restart that changes nothing must not look like churn,
  // or the counter that makes removals visible becomes noise nobody reads.
  const s = store()
  seed(s, 'fleet:a', 'mini:testing')
  seed(s, 'fleet:b', 'mini:testing')

  s.replaceAgentDaemonRoutes('mini:testing', ['fleet:a', 'fleet:b'])
  const again = s.replaceAgentDaemonRoutes('mini:testing', ['fleet:a', 'fleet:b'])

  assert.deepEqual({ kept: again.kept, removed: again.removed }, { kept: 2, removed: 0 })
  assert.equal(s.getAgentDaemonRoute('fleet:a')?.daemon_key, 'mini:testing')
  assert.equal(s.getAgentDaemonRoute('fleet:b')?.daemon_key, 'mini:testing')
})

test('duplicate ids in a roster are counted once', () => {
  const s = store()
  seed(s, 'fleet:a', 'mini:testing')
  const result = s.replaceAgentDaemonRoutes('mini:testing', ['fleet:a', 'fleet:a', ''])
  assert.equal(result.kept, 1)
  assert.equal(s.getAgentDaemonRoute('fleet:a')?.daemon_key, 'mini:testing')
})

test('the store method is exposed to the server, not only defined on the class', () => {
  // The server reaches the store through a generated proxy, so a method that is
  // not named in the registry does not exist at the call site -- and the failure
  // is a runtime "not a function" inside a daemon message handler, which is
  // exactly where tonight's silent failures lived.
  assert.ok(FLEET_STORE_METHODS.includes('replaceAgentDaemonRoutes'),
    'replaceAgentDaemonRoutes must be in the method registry or the server cannot call it')
})
