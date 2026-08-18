#!/usr/bin/env node
// A supervised bot restarts under the mint id it already has. Every fact that
// describes *this launch* rather than *this identity* is therefore different
// from the one already stored, and `setFact` calls any difference a conflict and
// throws -- which stopped the restart before the process ever started.
//
// This was unreachable until mint-id reuse became structural: before that a bot
// got a fresh mint row per start, so these columns were always empty on arrival.
// The reuse is the design; the conflict check is what it outgrew.
//
// Measured rather than assumed, which is why this test exists in this shape: on
// a second mint under the same id, THREE facts throw, not the one that was
// reported. Fixing only `launch_recipe` moves the failure to `session_id` inside
// the same restart.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDaemonMintCore } from '../daemon/mint-core.mjs'
import { MintStore } from '../daemon/mint-store.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-supervised-restart-'))
const store = new MintStore(path.join(dir, 'mint.sqlite'), { defaultEnvName: 'testing' })
const MINT_ID = 'bot:testing:todd'

// One durable participant per environment: the same mint id both times, which is
// what `botMintId(envName, botName)` produces for a supervised bot.
function coreForStart({ sessionId, cwd }) {
  return createDaemonMintCore({
    store,
    envName: 'testing',
    launchProcess: async () => ({ session_id: sessionId, session_path: `/sessions/${sessionId}`, tmux_session: 'fleet-todd' }),
    requestSeat: async () => ({ fleet_id: 'fleet:todd', friendly_name: 'todd' }),
    bindSeat: async () => {},
    // Nothing is running between starts -- the supervisor killed it. Without
    // this the second mint reuses the recorded process instead of launching.
    processAlive: async () => false,
  })
}

const first = await coreForStart({ sessionId: 'session-1', cwd: '/one' }).mint({
  mint_id: MINT_ID,
  name: 'todd',
  metadata: { kind: 'bot' },
  launch: { kind: 'bot', model: 'bot', cwd: '/one' },
})
assert.equal(first.fleetId, 'fleet:todd')
assert.equal(first.sessionId, 'session-1')
assert.deepEqual(first.launchRecipe, { kind: 'bot', model: 'bot', cwd: '/one' })

// The restart. Same identity, different launch: a changed cwd stands in for the
// resolved model alias, daemon config or newly-added field that makes a real
// bot's recipe differ between builds. The session is new because the process is.
const second = await coreForStart({ sessionId: 'session-2', cwd: '/two' }).mint({
  mint_id: MINT_ID,
  name: 'todd',
  metadata: { kind: 'bot' },
  launch: { kind: 'bot', model: 'bot', cwd: '/two' },
})

// Before the fix this never returned -- it threw
// `mint bot:testing:todd already has a different launch_recipe`.
assert.equal(second.fleetId, 'fleet:todd', 'the restart keeps the identity it already had')
assert.equal(second.friendlyName, 'todd')

// The stored facts describe the launch that is now running, not the first one
// ever recorded. wake-core and wake-permission-profile read these back to
// relaunch, so a stale recipe would resume the bot into its old configuration.
assert.deepEqual(second.launchRecipe, { kind: 'bot', model: 'bot', cwd: '/two' }, 'the recipe is this launch, not the first')
assert.equal(second.sessionId, 'session-2', 'the session is this process, not the dead one')
assert.equal(second.sessionPath, '/sessions/session-2')

// And no second identity was minted along the way -- the failure mode the reuse
// exists to prevent.
assert.equal(store.get(MINT_ID).fleetId, 'fleet:todd')

fs.rmSync(dir, { recursive: true, force: true })
console.log('PASS: a supervised bot restarts under the identity it already has')
