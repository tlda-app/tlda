import test from 'node:test'
import assert from 'node:assert/strict'

import { createDaemonWakeCore } from './wake-core.mjs'

// WHICH KEYS NAME AN AGENT TO `wake`, asserted because getting it wrong is
// silent until it is destructive.
//
// `rpcRestart` forwards its own params straight through to this function, so a
// caller that says `{ agent_id }` — the name every other daemon RPC uses —
// passes the restart's own guard, KILLS THE SESSION, and only then fails to
// resolve an identifier. The agent is left down by the remedy meant to restore
// it. That happened on the live daemon twice within four minutes of the
// notification-symptom path going live, and nothing in the types or the
// signature says `agent_id` is the wrong word here.

const facts = { mintId: 'mint-1', fleetId: 'fleet:abc', sessionId: 'sess-1', launchRecipe: { kind: 'claude' } }

function wakeWith({ resolved = facts } = {}) {
  const seen = []
  const wake = createDaemonWakeCore({
    store: { resolve: id => { seen.push(id); return resolved } },
    processAlive: async () => false,
    resumeSession: async () => ({ ok: true }),
  })
  return { wake, seen }
}

test('fleet_id, mint_id and name all identify an agent', async () => {
  for (const params of [
    { fleet_id: 'fleet:abc' },
    { fleetId: 'fleet:abc' },
    { mint_id: 'mint-1' },
    { mintId: 'mint-1' },
    { name: 'some-agent' },
  ]) {
    const { wake, seen } = wakeWith()
    await wake(params).catch(() => {})   // what happens AFTER resolution is not this test's subject
    assert.equal(seen.length, 1, `${JSON.stringify(params)} should have reached identifier resolution`)
  }
})

test('a bare string is taken as a fleet id', async () => {
  const { wake, seen } = wakeWith()
  await wake('fleet:abc').catch(() => {})
  assert.deepEqual(seen, ['fleet:abc'])
})

// The one that cost a live agent.
test('agent_id ALONE does not identify an agent, and callers must not rely on it', async () => {
  const { wake, seen } = wakeWith()
  await assert.rejects(
    () => wake({ agent_id: 'fleet:abc' }),
    /requires a local mint, fleet, or friendly-name identifier/,
    'agent_id is not an accepted identifier here — pass fleet_id alongside it',
  )
  assert.equal(seen.length, 0, 'nothing should have been resolved')
})

test('agent_id together with fleet_id is fine, which is the fix', async () => {
  const { wake, seen } = wakeWith()
  await wake({ agent_id: 'fleet:abc', fleet_id: 'fleet:abc' }).catch(() => {})
  assert.deepEqual(seen, ['fleet:abc'], 'agent_id alongside fleet_id must reach resolution')
})

// Control: the rejection above must come from the identifier check and not from
// the stub store, or the test would pass for the wrong reason.
test('an accepted identifier that resolves to nothing fails differently', async () => {
  const { wake } = wakeWith({ resolved: null })
  await assert.rejects(() => wake({ fleet_id: 'fleet:ghost' }), /no daemon mint facts for fleet:ghost/)
})
