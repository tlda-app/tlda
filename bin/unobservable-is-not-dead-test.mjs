#!/usr/bin/env node
// A failure to observe must not read as an observation of absence.
//
// `sessionRuntimeState` answers `runtime: false` for two different facts: tmux
// answered and nothing is running, and the probe itself failed -- a missing tmux
// socket, or `ps` exceeding its 5s timeout. `rpcMint` used to negate `runtime`
// to decide whether to mark a mint's pre-reserved bot seat dead, with a comment
// saying that marking a live agent's seat dead would retire its identity. On a
// loaded box -- which is when `ps` is slowest and when mints are already failing
// -- that is exactly what it did.
//
// The two cases diverge only under load, so nothing catches this by running it
// on an idle machine. `probed` is what makes them distinguishable at all.
import assert from 'node:assert/strict'
import { sessionConfirmedDead, sessionRuntimeState } from '../agent-launch/tmux.mjs'

// A socket path that cannot answer. This is the catch path in the real function,
// reached the way production reaches it, rather than a stubbed rejection.
const unreachable = await sessionRuntimeState('fleet-nonexistent-session', {
  tmuxSocket: '/nonexistent/tlda-unobservable-probe.sock',
})

assert.equal(unreachable.runtime, false, 'an unreachable probe still reports no runtime')
assert.equal(unreachable.probed, false, 'an unreachable probe must report that it did not look')
assert.equal(
  sessionConfirmedDead(unreachable),
  false,
  'a probe that could not look must never be read as confirmed dead -- this is the assertion that fails without the fix, because !runtime is true here',
)

// The shape a real observation has. Kept as a literal rather than by starting a
// tmux session: what is under test is the discriminator, and a test that needs a
// live tmux server to assert it would not run on a box that is too loaded to
// have one -- which is the condition this defect belongs to.
assert.equal(sessionConfirmedDead({ runtime: false, probed: true }), true, 'tmux answered and nothing is running: confirmed dead')
assert.equal(sessionConfirmedDead({ runtime: true, probed: true }), false, 'something is running: not dead')
assert.equal(sessionConfirmedDead(null), false, 'no state at all is not a confirmation')
assert.equal(sessionConfirmedDead(undefined), false, 'no state at all is not a confirmation')

// The old predicate, for the record: `!state.runtime` returns true for the
// unreachable probe above. That is the retirement of a live agent's identity.
assert.equal(!unreachable.runtime, true, 'the predicate this replaces would have said dead')

console.log('PASS: an unobservable session is not a dead one')
