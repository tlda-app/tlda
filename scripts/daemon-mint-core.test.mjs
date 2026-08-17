import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDaemonMintCore, recordedMintIdentity } from '../daemon/mint-core.mjs'
import { MintFactConflictError, MintStore, readMintFacts, resolveLoginFleetId } from '../daemon/mint-store.mjs'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-mint-core-'))
const store = new MintStore(path.join(dir, 'mint.sqlite'), { defaultEnvName: 'testing' })
const events = []
let releaseProcess
let releaseSeat

const core = createDaemonMintCore({
  store,
  mintId: () => 'mint:test',
  launchProcess: async () => {
    events.push('process-start')
    await new Promise(resolve => { releaseProcess = resolve })
    return { session_id: 'session:test', tmux_session: 'fleet-test' }
  },
  requestSeat: async () => {
    events.push('seat-start')
    await new Promise(resolve => { releaseSeat = resolve })
    return { fleet_id: 'fleet:test', friendly_name: 'test' }
  },
  bindSeat: async facts => {
    events.push(`bind:${facts.fleetId}:${facts.sessionId}`)
  },
})

const pending = core.mint({ name: 'test', launch: { cwd: '/tmp' } })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(events, ['process-start', 'seat-start'])
releaseSeat()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(events, ['process-start', 'seat-start'])
assert.equal(store.get('mint:test').fleetId, 'fleet:test')
assert.equal(store.get('mint:test').sessionId, null)
assert.equal(store.get('mint:test').envName, null)
assert.equal(readMintFacts(path.join(dir, 'mint.sqlite'), 'mint:test').fleetId, 'fleet:test')
assert.equal(readMintFacts(path.join(dir, 'mint.sqlite'), 'mint:missing'), null)
assert.equal(resolveLoginFleetId({
  mintId: 'mint:test',
  storeFile: path.join(dir, 'mint.sqlite'),
}), 'fleet:test')
assert.equal(resolveLoginFleetId({
  mintId: 'mint:missing',
  storeFile: path.join(dir, 'mint.sqlite'),
}), null)
releaseProcess()
const facts = await pending
assert.equal(facts.fleetId, 'fleet:test')
assert.equal(facts.sessionId, 'session:test')
assert.equal(events.filter(value => value.startsWith('bind:')).length, 1)

const lifecycleEvents = []
let lifecycleSeatAttempts = 0
const lifecycleCore = createDaemonMintCore({
  store,
  mintId: () => 'mint:lifecycle',
  launchProcess: async () => ({ session_id: 'session:lifecycle', tmux_session: 'fleet-lifecycle', cwd: '/tmp/lifecycle', harness: 'codex', model: 'gpt-test' }),
  requestSeat: async () => {
    lifecycleSeatAttempts++
    if (lifecycleSeatAttempts === 1) throw new Error('server unavailable')
    return { fleet_id: 'fleet:lifecycle', friendly_name: 'lifecycle' }
  },
  bindSeat: async () => {},
  sleep: async () => {},
  retryDelay: () => 25,
})
const lifecycleFacts = await lifecycleCore.mint({
  name: 'lifecycle',
  launch: { cwd: '/tmp/lifecycle', kind: 'codex', model: 'gpt-test' },
  onLifecycleEvent: (event, data) => lifecycleEvents.push([event, data]),
})
assert.equal(lifecycleFacts.fleetId, 'fleet:lifecycle')
assert.equal(lifecycleFacts.joinedAt != null, true)
// `local-launch` and `server-registration-joined` are two concurrent branches
// reporting things that already happened, so their order relative to each other
// is scheduling, not contract; it moved by one microtask when recordSeat stopped
// awaiting bindSeat. What IS contract is that all six events are emitted and that
// `server-binding-joined` comes last — the binding is the only one of them that
// cannot have happened before the others.
assert.deepEqual(
  lifecycleEvents.map(([event]) => event).slice().sort(),
  ['local-launch', 'server-binding-joined', 'server-registration-attempt', 'server-registration-attempt', 'server-registration-deferred', 'server-registration-joined'].slice().sort(),
)
assert.equal(lifecycleEvents.at(-1)[0], 'server-binding-joined')
// Emitted once, by the binding loop. It used to be emitted from whichever branch
// first observed `joinedAt`, in two places with the same shape.
assert.equal(lifecycleEvents.filter(([event]) => event === 'server-binding-joined').length, 1)
const launchEvent = lifecycleEvents.find(([event]) => event === 'local-launch')[1]
assert.equal(lifecycleEvents[0][1].local_agent_id, 'mint:lifecycle')
assert.equal(launchEvent.tmux_session, 'fleet-lifecycle')
assert.equal(launchEvent.local_agent_id, 'mint:lifecycle')
assert.equal(lifecycleEvents[1][1].reason, 'server unavailable')
assert.equal(lifecycleEvents[1][1].retry_in_ms, 25)

// One transient bind failure must not become a second seat request.
//
// This is the shell-minting loop: recordSeat ended with `await join()`, whose
// first act is a server-backed permissionLedger.set, and that call sat inside the
// seat-request try. So a failed ledger write was caught by the seat-request
// handler, which asked the server for another seat — and the server has no memory
// of a mint id, so every request minted a fresh shell row. 171 orphan rows since
// 08-06, at the 30s backoff cap, from failures that were over in seconds.
//
// The store would not even let the retry adopt the row it had just created:
// `fleet_id` is a conflict-checked fact, so the second seat's id is rejected and
// the mint keeps its first identity while orphaning every shell after it.
let bindFailureSeatRequests = 0
let bindFailuresLeft = 2
const bindRetryEvents = []
const bindRetryCore = createDaemonMintCore({
  store,
  envName: 'testing',
  mintId: () => 'mint:bind-retry',
  launchProcess: async () => ({ session_id: 'session:bind-retry', tmux_session: 'fleet-bind-retry' }),
  requestSeat: async () => {
    bindFailureSeatRequests++
    return { fleet_id: `fleet:bind-retry-${bindFailureSeatRequests}`, friendly_name: 'bind-retry' }
  },
  bindSeat: async () => {
    if (bindFailuresLeft-- > 0) throw new Error('permission ledger write failed')
  },
  sleep: async () => {},
  retryDelay: () => 1,
})
const bindRetryFacts = await bindRetryCore.mint({
  name: 'bind-retry',
  launch: { cwd: '/tmp/bind-retry' },
  onLifecycleEvent: (event, data) => bindRetryEvents.push([event, data]),
})
assert.equal(bindFailureSeatRequests, 1, 'a bind failure must not request another seat')
assert.equal(bindRetryFacts.fleetId, 'fleet:bind-retry-1')
assert.equal(bindRetryFacts.joinedAt != null, true)
assert.equal(bindRetryEvents.filter(([event]) => event === 'server-binding-error').length, 2)
assert.equal(bindRetryEvents.at(-1)[0], 'server-binding-joined')

// Both retry loops were `for (;;)` with no cap, no deadline and no give-up, so a
// mint that could not finish never stopped and never told anyone. A seat that
// never comes now ends, once, with a reason.
let deadlineSeatRequests = 0
const deadlineEvents = []
let fakeClock = 0
const deadlineCore = createDaemonMintCore({
  store,
  envName: 'testing',
  mintId: () => 'mint:deadline',
  launchProcess: async () => ({ session_id: 'session:deadline', tmux_session: 'fleet-deadline' }),
  requestSeat: async () => {
    deadlineSeatRequests++
    throw new Error('server unavailable')
  },
  bindSeat: async () => { throw new Error('unreachable: no seat was ever issued') },
  sleep: async ms => { fakeClock += ms },
  retryDelay: () => 1_000,
  registrationDeadlineMs: 5_000,
  monotonicNow: () => fakeClock,
})
const deadlineFacts = await deadlineCore.mint({
  name: 'deadline',
  launch: { cwd: '/tmp/deadline' },
  onLifecycleEvent: (event, data) => deadlineEvents.push([event, data]),
})
assert.equal(deadlineSeatRequests, 5)
assert.equal(deadlineFacts.fleetId, null)
assert.equal(deadlineFacts.joinedAt, null)
assert.match(deadlineFacts.registrationError, /gave up requesting a fleet seat after 5 attempts/)
assert.equal(deadlineEvents.filter(([event]) => event === 'server-registration-abandoned').length, 1)
// No seat was issued, so there is nothing to bind and no binding loop to spin.
assert.equal(deadlineEvents.filter(([event]) => event === 'server-binding-deferred').length, 0)

// A seat that binds but never publishes its route ends too, and says which of the
// two it was: `registrationError` stays unset, so the daemon reports `join-failed`
// rather than `registration-deferred`.
const bindDeadlineEvents = []
let bindClock = 0
const bindDeadlineCore = createDaemonMintCore({
  store,
  envName: 'testing',
  mintId: () => 'mint:bind-deadline',
  launchProcess: async () => ({ session_id: 'session:bind-deadline', tmux_session: 'fleet-bind-deadline' }),
  requestSeat: async () => ({ fleet_id: 'fleet:bind-deadline', friendly_name: 'bind-deadline' }),
  bindSeat: async () => { throw new Error('permission ledger unreachable') },
  sleep: async ms => { bindClock += ms },
  retryDelay: () => 1_000,
  registrationDeadlineMs: 3_000,
  monotonicNow: () => bindClock,
})
const bindDeadlineFacts = await bindDeadlineCore.mint({
  name: 'bind-deadline',
  launch: { cwd: '/tmp/bind-deadline' },
  onLifecycleEvent: (event, data) => bindDeadlineEvents.push([event, data]),
})
assert.equal(bindDeadlineFacts.fleetId, 'fleet:bind-deadline')
assert.equal(bindDeadlineFacts.joinedAt, null)
assert.equal(bindDeadlineFacts.registrationError, undefined)
assert.equal(bindDeadlineEvents.filter(([event]) => event === 'server-binding-abandoned').length, 1)

let resumedLaunches = 0
const resumedCore = createDaemonMintCore({
  store,
  processAlive: async () => true,
  launchProcess: async () => { resumedLaunches++; return { session_id: 'duplicate', tmux_session: 'duplicate' } },
  requestSeat: async () => ({ fleet_id: 'fleet:resumed', friendly_name: 'resumed' }),
  bindSeat: async () => {},
})
store.ensure('mint:resumed')
store.setFact('mint:resumed', 'friendly_name', 'resumed')
store.setFact('mint:resumed', 'process_state', { session_id: 'session:resumed', tmux_session: 'fleet-resumed' })
store.setFact('mint:resumed', 'session_id', 'session:resumed')
const resumedFacts = await resumedCore.mint({ mint_id: 'mint:resumed', name: 'resumed' })
assert.equal(resumedLaunches, 0)
assert.equal(resumedFacts.fleetId, 'fleet:resumed')

let staleLaunches = 0
const staleCore = createDaemonMintCore({
  store,
  processAlive: async () => false,
  launchProcess: async () => {
    staleLaunches++
    return { session_id: 'session:stale', tmux_session: 'fleet-stale' }
  },
  requestSeat: async () => ({ fleet_id: 'fleet:stale', friendly_name: 'stale' }),
  bindSeat: async () => {},
})
store.ensure('mint:stale')
store.setFact('mint:stale', 'friendly_name', 'stale')
store.setFact('mint:stale', 'process_state', { session_id: 'session:stale', tmux_session: 'fleet-stale' })
store.setFact('mint:stale', 'session_id', 'session:stale')
const staleFacts = await staleCore.mint({ mint_id: 'mint:stale', name: 'stale' })
assert.equal(staleLaunches, 1)
assert.equal(staleFacts.fleetId, 'fleet:stale')

store.setFact('mint:test', 'fleet_id', 'fleet:test')
assert.throws(
  () => store.setFact('mint:test', 'fleet_id', 'fleet:other'),
  error => error instanceof MintFactConflictError && error.code === 'mint-fact-conflict',
)

const serverEvents = []
const serverCore = createDaemonMintCore({
  store,
  mintId: () => 'mint:server',
  launchProcess: async input => {
    serverEvents.push(`launch:${input.fleet_id}`)
    return { session_id: 'session:server', tmux_session: 'fleet-server' }
  },
  requestSeat: async () => {
    throw new Error('server mint must not request a second seat')
  },
  bindSeat: async facts => serverEvents.push(`bind:${facts.fleetId}:${facts.sessionId}`),
})
await serverCore.mint({ mint_id: 'mint:server', fleet_id: 'fleet:server', name: 'server' })
assert.deepEqual(serverEvents, ['launch:fleet:server', 'bind:fleet:server:session:server'])

const envCore = createDaemonMintCore({
  store,
  envName: 'testing',
  mintId: () => 'mint:env',
  launchProcess: async () => ({ session_id: 'session:env', tmux_session: 'fleet-env' }),
  requestSeat: async () => ({ fleet_id: 'fleet:env', friendly_name: 'env-bot' }),
  bindSeat: async () => {},
})
await envCore.mint({ name: 'env-bot' })
assert.equal(store.get('mint:env').envName, 'testing')
assert.equal(store.resolve('env-bot', { envName: 'testing' }).fleetId, 'fleet:env')
assert.equal(store.resolve('env-bot', { envName: 'stable' }), null)

const markerRaceEvents = []
const markerRaceCore = createDaemonMintCore({
  store,
  mintId: () => 'mint:marker-race',
  launchProcess: async () => ({ session_id: 'session:unused' }),
  requestSeat: async () => ({ fleet_id: 'fleet:unused' }),
  bindSeat: async facts => markerRaceEvents.push(`bind:${facts.fleetId}:${facts.sessionId}`),
})
store.ensure('mint:marker-race')
store.setFact('mint:marker-race', 'fleet_id', 'fleet:marker-race')
await markerRaceCore.recordSession('mint:marker-race', { session_id: 'session:marker-race' })
assert.deepEqual(markerRaceEvents, [])
await markerRaceCore.recordProcess('mint:marker-race', {
  session_id: 'session:marker-race',
  tmux_session: 'fleet-marker-race',
})
assert.deepEqual(markerRaceEvents, ['bind:fleet:marker-race:session:marker-race'])

let alive = true
const wake = createDaemonWakeCore({
  store,
  processAlive: async () => alive,
  resumeSession: async facts => {
    alive = true
    return { tmux_session: `resumed-${facts.sessionId}` }
  },
})
assert.equal((await wake('fleet:server')).alreadyAlive, true)
alive = false
const resumed = await wake('fleet:server')
assert.equal(resumed.resumed, true)
assert.equal(resumed.tmux_session, 'resumed-session:server')
assert.rejects(() => wake('fleet:missing'), /no daemon mint facts/)

// A supervised bot mints under the same mint id on every start. Once that mint
// holds a fleet id, the restart must relaunch that identity and ask the allocator
// for nothing — otherwise the launcher competes with its own child for the child's
// name, and the shell it creates blocks the next start.
let namedRestartLaunches = 0
const namedRestartCore = createDaemonMintCore({
  store,
  envName: 'stable',
  processAlive: async () => false,
  launchProcess: async input => {
    namedRestartLaunches++
    return { fleet_id: input.fleet_id, session_id: 'session:bot-restart', tmux_session: 'fleet-bot-restart' }
  },
  requestSeat: async () => { throw new Error('a restart must not request a seat') },
  bindSeat: async () => {},
})
store.ensure('bot:stable:restart')
store.setFact('bot:stable:restart', 'friendly_name', 'restart')
store.setFact('bot:stable:restart', 'fleet_id', 'fleet:bot-restart')
store.setFact('bot:stable:restart', 'process_state', { session_id: 'session:bot-restart', tmux_session: 'fleet-bot-restart' })
store.setFact('bot:stable:restart', 'session_id', 'session:bot-restart')
const namedRestart = await namedRestartCore.mint({ mint_id: 'bot:stable:restart', name: 'restart' })
assert.equal(namedRestartLaunches, 1)
assert.equal(namedRestart.fleetId, 'fleet:bot-restart')

// The same question the daemon asks before reserving a bot seat of its own. It has
// to agree with what mint() would have done, or the reservation re-creates the
// agent mint() was going to reuse and takes its name away from it.
assert.equal(recordedMintIdentity(store, 'bot:stable:restart').fleetId, 'fleet:bot-restart')
assert.equal(recordedMintIdentity(store, 'bot:stable:never-started'), null)
assert.equal(recordedMintIdentity(store, null), null)
store.ensure('bot:stable:reserved-not-bound')
store.setFact('bot:stable:reserved-not-bound', 'friendly_name', 'reserved-not-bound')
assert.equal(recordedMintIdentity(store, 'bot:stable:reserved-not-bound'), null)

// A mint that asks for a taken name is assigned an alternate rather than rejected.
// The ledger has to be able to write that answer down: treating it as a conflict
// with the requested name leaves the seat unrecordable, and mint-core retries an
// unrecordable seat forever.
const rotatedCore = createDaemonMintCore({
  store,
  envName: 'stable',
  mintId: () => 'bot:stable:rotated',
  launchProcess: async () => ({ session_id: 'session:rotated', tmux_session: 'fleet-rotated' }),
  requestSeat: async () => ({ fleet_id: 'fleet:rotated', friendly_name: 'qotated' }),
  bindSeat: async () => {},
})
const rotated = await rotatedCore.mint({ name: 'rotated' })
assert.equal(rotated.fleetId, 'fleet:rotated')
assert.equal(rotated.friendlyName, 'qotated')
assert.equal(store.resolve('qotated', { envName: 'stable' }).mintId, 'bot:stable:rotated')

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('daemon mint core tests passed')
