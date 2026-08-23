// `tlda agent attach` must distinguish the two states that differ, because they
// need different next actions: no such agent, and this agent has no session.
// Before this, a mint record naming a session that is no longer running fell
// through to tmux, and the caller got `can't find session: fleet-x` — a fact
// about a terminal, offered as an answer about an agent. Skip hit exactly that
// and read it as the agent not existing.
import assert from 'node:assert/strict'

import { attachToAgent } from '../cli/tlda.mjs'

const agentRow = {
  mintId: 'mint:ghost',
  fleetId: 'fleet:ghost',
  friendlyName: 'ghost-agent',
  processState: { tmux_session: 'fleet-ghost-agent' },
}

function ledgerFor(row) {
  return () => ({ resolve: () => row, close() {} })
}

// --- the session is gone -------------------------------------------------
const calls = []
const errors = []
let exitCode = null

const gone = await attachToAgent('ghost-agent', {
  openLedger: ledgerFor(agentRow),
  spawnSyncImpl: (command, args) => {
    calls.push(args[args.length - 3])
    // has-session fails; attach-session must never be reached.
    return { status: 1 }
  },
  log: { error: m => errors.push(m) },
  exitImpl: code => { exitCode = code },
})

assert.equal(gone.ok, false)
assert.equal(gone.error, 'session-missing')
assert.equal(exitCode, 1)

// The check ran and the attach did NOT. If this ever reverses, the caller is
// back to reading tmux's error about a terminal.
assert.deepEqual(calls, ['has-session'], 'attach-session must not be attempted when the session is absent')

const joined = errors.join('\n')
assert.match(joined, /ghost-agent/)
assert.match(joined, /no running terminal/)
assert.match(joined, /fleet-ghost-agent/)
// It must NOT claim the agent is gone, dead, or missing as a record. Death is a
// flag somebody sets; an absent terminal is not evidence of one.
assert.doesNotMatch(joined, /\bdead\b/i)
assert.doesNotMatch(joined, /No local agent found/)
assert.match(joined, /record is intact/)

// --- counterfactual: the session is there, and attach still happens ------
// Without this the assertion above passes for a build that refuses to attach to
// anything, which is a worse bug than the one being fixed.
const liveCalls = []
const live = await attachToAgent('ghost-agent', {
  openLedger: ledgerFor(agentRow),
  spawnSyncImpl: (command, args) => {
    liveCalls.push(args[args.length - 3])
    return { status: 0 }
  },
  log: { error: m => { throw new Error(`unexpected error output: ${m}`) } },
  exitImpl: () => {},
})

assert.equal(live.ok, true)
assert.deepEqual(liveCalls, ['has-session', 'attach-session'])

// --- and a genuinely absent agent still says so, differently -------------
const absentErrors = []
const absent = await attachToAgent('nobody-here', {
  openLedger: ledgerFor(null),
  spawnSyncImpl: () => { throw new Error('tmux must not be consulted for an unknown agent') },
  log: { error: m => absentErrors.push(m) },
  exitImpl: () => {},
})

assert.equal(absent.ok, false)
assert.equal(absent.error, 'agent-not-found')
assert.match(absentErrors.join('\n'), /No local agent found/)

console.log('attach-missing-session-test: ok')
