import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { parseFilter } from '../shared/fleet-labels.mjs'

// "Pre-register / shell": the spawn flow registers an agent's identity BEFORE its
// process exists, so it's addressable in the not-dead registry but shows as a
// `shell` (not awake). The agent's own register is the claim that flips it awake.
// A spawn that dies before claiming is marked dead so the shell can't linger.

function makeStore(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  const liveIds = new Set()
  const store = new FleetStore(path.join(dir, 'fleet.db'))
  store.setLivenessOracle(id => liveIds.has(id))
  return {
    store,
    liveIds,
    async cleanup() {
      // best-effort teardown — ignore errors closing an already-gone resource
      try { await store._worker?.terminate() } catch {}
      try { store.db.close() } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    },
  }
}

test('a shell is addressable but not awake; the claim flips it to awake', async () => {
  const { store, liveIds, cleanup } = makeStore('fleet-shell-')
  try {
    // Pre-register: a shell row, dead=0, no live process.
    store.upsertAgent({ id: 'fleet:shellguy', friendly_name: 'shellguy', metadata: { shell: true } })

    const a = store.getAgent('fleet:shellguy')
    assert.equal(a.status, 'shell', 'pre-registered identity shows as shell, not awake/hibernating')
    assert.equal(a.dead, false)

    // Addressable: resolves by name in the not-dead registry, so messages queue.
    assert.deepEqual(
      store.resolveChatRecipients(parseFilter('shellguy'), { filter: 'shellguy' }),
      ['fleet:shellguy'],
      'a shell resolves as a chat recipient by name',
    )

    // The shell marker takes precedence over the liveness oracle: even if a
    // process appears live, it stays a shell until the flag is cleared.
    liveIds.add('fleet:shellguy')
    store.refreshAgentLiveness('fleet:shellguy')
    assert.equal(store.getAgent('fleet:shellguy').status, 'shell', 'shell flag overrides liveness until claimed')

    // Claim: the agent's own register clears the shell flag → awake. The flag is
    // cleared by patching shell:null (json_patch deletes a key only when patched
    // to null) — passing {} would leave the merged shell:true intact.
    store.upsertAgent({ id: 'fleet:shellguy', friendly_name: 'shellguy', metadata: { shell: null } })
    assert.equal(store.getAgent('fleet:shellguy').metadata?.shell, undefined, 'shell flag deleted from stored metadata')
    store.refreshAgentLiveness('fleet:shellguy')
    assert.equal(store.getAgent('fleet:shellguy').status, 'awake', 'claim clears shell → awake')
  } finally {
    await cleanup()
  }
})

test('a failed shell, marked dead, drops out of the addressable registry', async () => {
  const { store, cleanup } = makeStore('fleet-shell-dead-')
  try {
    store.upsertAgent({ id: 'fleet:flop', friendly_name: 'flop', metadata: { shell: true } })
    assert.deepEqual(store.resolveChatRecipients(parseFilter('flop'), { filter: 'flop' }), ['fleet:flop'])
    store.markDead('fleet:flop')
    assert.equal(store.getAgent('fleet:flop').status, 'dead')
    assert.deepEqual(
      store.resolveChatRecipients(parseFilter('flop'), { filter: 'flop' }),
      [],
      'a dead shell is no longer addressable',
    )
  } finally {
    await cleanup()
  }
})

test('register handler: shell pre-register sets the flag and skips mark-alive; claim clears it', () => {
  const src = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  // Shell set on pre-register, cleared on claim.
  assert.match(src, /if \(msg\.shell\) \{\s*agent\.metadata = \{ \.\.\.\(agent\.metadata \|\| \{\}\), shell: true \}/)
  assert.match(src, /\} else if \(agent\.metadata\?\.shell\) \{[\s\S]*?agent\.metadata = \{ \.\.\.agent\.metadata, shell: null \}/)
  // Mark-alive is gated so a shell is NOT marked awake (the roster-lie fix).
  assert.match(src, /if \(!agent\.human && !msg\.shell\) \{\s*\n\s*markAgentAlive\(agentId\)/)
  // A failed shell is marked dead.
  assert.match(src, /if \(agent\?\.metadata\?\.shell\) fleetStore\.markDead\?\.\(agent_id\)/)
})

test('spawn flow pre-registers a shell before launch', () => {
  const src = readFileSync(new URL('../bin/fleet-spawn.py', import.meta.url), 'utf8')
  // ws_register forwards a shell flag.
  assert.match(src, /def ws_register\([\s\S]*?shell=False\)/)
  assert.match(src, /if shell:\s*\n\s*msg\["shell"\] = True/)
  // fresh() pre-registers as a shell before building/launching the agent command.
  assert.match(src, /ws_register\(\s*\n\s*fleet_id, name, sess, cwd, model, effort, refresh=True, shell=True,/)
})
