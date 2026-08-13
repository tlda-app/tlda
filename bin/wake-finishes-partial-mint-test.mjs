#!/usr/bin/env node
// A mint the daemon prepared but no harness ever logged in to has facts and a
// launch recipe and no session id. Finishing it is what the recipe is for.
//
// Before this, wake threw `not resumable: no session_id` and the half-minted
// agent could never be completed by any call — the caller's only route was a
// fresh mint under a new identity, and the prepared one leaked. Three mints hit
// that throw on 2026-08-12 alone.
//
// Skip, 2026-08-12 00:12 EDT: "the idea is, like, mint would finish minting a
// fucking agent that was, like, partially minted".
import assert from 'node:assert/strict'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'

function harness({ sessionId, launchRecipe, joinedAt = null, aliveFrom = false }) {
  const calls = []
  let alive = aliveFrom
  const wake = createDaemonWakeCore({
    store: {
      resolve: fleetId => ({ mintId: 'mint-1', fleetId, sessionId, launchRecipe, joinedAt, friendlyName: 'half-minted' }),
      updateProcessState: (mintId, processState) => ({ mintId, fleetId: 'fleet:test', sessionId, processState }),
    },
    processAlive: async () => alive,
    resumeSession: async (facts) => {
      calls.push({ resumeId: facts.sessionId ?? null, recipe: facts.launchRecipe ?? null })
      alive = true
      return { resumed: true }
    },
  })
  return { wake, calls }
}

// 1. The partial mint — facts and a recipe, no session. This is the new path.
{
  const { wake, calls } = harness({ sessionId: null, launchRecipe: { kind: 'codex', cwd: '/tmp' } })
  const result = await wake({ fleet_id: 'fleet:test' })
  assert.equal(result.ok, true)
  assert.equal(result.resumed, true, 'a partially minted agent must be finished, not refused')
  assert.equal(calls.length, 1)
  // Null resumeId is the whole difference from an ordinary resume: there is no
  // session to attach to, so the recipe is relaunched under the same identity.
  assert.equal(calls[0].resumeId, null)
  assert.equal(calls[0].recipe.kind, 'codex')
}

// 2. Nothing to finish — no session AND no recipe. Still refused, and the
//    message says which of the two is missing rather than only the session.
{
  const { wake, calls } = harness({ sessionId: null, launchRecipe: null })
  await assert.rejects(
    () => wake({ fleet_id: 'fleet:test' }),
    /not resumable: no session_id and no launch recipe/,
  )
  assert.equal(calls.length, 0, 'a mint with no recipe must not be relaunched')
}

// 3. Control — an ordinary resume is unchanged and still carries its session.
{
  const { wake, calls } = harness({ sessionId: 'session-1', launchRecipe: { kind: 'codex' }, joinedAt: '2026-08-13T00:00:00Z' })
  const result = await wake({ fleet_id: 'fleet:test' })
  assert.equal(result.resumed, true)
  assert.equal(calls[0].resumeId, 'session-1')
}

// 4. A live process that never joined. It has no registry row, so it cannot be
//    addressed by anyone — and this used to return ok:true, alreadyAlive:true.
//    That was the third surface reporting health over the same absence on
//    2026-08-13, after the mint and the delegate had both done it.
{
  const { wake, calls } = harness({ sessionId: 'session-1', launchRecipe: { kind: 'codex' }, joinedAt: null, aliveFrom: true })
  await assert.rejects(
    () => wake({ fleet_id: 'fleet:test' }),
    /live process that never joined/,
    'a running process with no registry row is not a woken agent',
  )
  assert.equal(calls.length, 0)
}

// 5. Control for 4 — the same live process, joined. Still the ordinary
//    already-alive success, so the check keys on the join and not on liveness.
{
  const { wake, calls } = harness({ sessionId: 'session-1', launchRecipe: { kind: 'codex' }, joinedAt: '2026-08-13T00:00:00Z', aliveFrom: true })
  const result = await wake({ fleet_id: 'fleet:test' })
  assert.equal(result.ok, true)
  assert.equal(result.alreadyAlive, true)
  assert.equal(calls.length, 0)
}

console.log('wake finishes a partial mint: ok')
