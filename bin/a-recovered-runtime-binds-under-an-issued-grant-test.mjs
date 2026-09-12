#!/usr/bin/env node
// The recovery adopted a live runtime and wrote `permission_grant: null` for it
// whenever there was no ledger row to read one from. `recordProcess` persists
// the process fact and only afterwards does `bindSeat` look at the grant, so the
// rejection arrived after the write it should have prevented: the mint ended up
// with process state recorded, a null grant, and no join -- alive, unbound, and
// unaddressable. That is the partial-runtime shape this test reproduces.
//
// Two things are under test. Where the grant comes from -- one coherent ledger
// binding, else the same mint's durable compiled `launchRecipe.permissionGrant`,
// and nothing else ever -- and when it is resolved, which must be before any
// write rather than after one.
//
// The wiring below is the daemon's: the real decision module, the real authority
// module, the real mint core doing the write and the join, and the real wake
// core confirming it. Only the box is faked -- tmux, the runtime probe, and the
// permission ledger.
import assert from 'node:assert/strict'
import { resolvePartialMintRuntime } from '../daemon/partial-mint-runtime-recovery.mjs'
import { resolvePartialMintPermissionAuthority } from '../daemon/partial-mint-permission-authority.mjs'
import { normalizePermissionGrant } from '../server/lib/permission-grants.mjs'
import { createDaemonMintCore } from '../daemon/mint-core.mjs'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'

const CONFIG = {
  permissionProfiles: {
    'app-dev': { allow: ['Read', 'Edit'], deny: [] },
    'ops': { allow: ['Read', 'Bash'], deny: [] },
  },
}

const CWD = '/home/user/work/tlda'
const RECIPE = { kind: 'codex', cwd: CWD, model: 'opus', permissionGrant: 'app-dev' }
const LIVE = 'fleet-half-minted'

// The identity fields of the already-partial row, kept verbatim so a rewrite of
// any one of them is visible as a failure rather than as a passing test.
const RECORDED_PROCESS = {
  mint_id: 'mint-1',
  fleet_id: 'fleet:recovered-runtime',
  name: 'half-minted',
  tmux_session: LIVE,
  pid: 54321,
  cwd: CWD,
  harness: 'codex',
  model: 'opus',
  session_id: 'session-live',
  session_path: '/rollouts/session-live.jsonl',
  permission_grant: null,
  machine_id: 'mini',
  env_name: 'testing',
  daemon_key: 'mini:testing',
  alive: true,
}

function memoryStore(rows = {}) {
  const store = { rows: { ...rows } }
  const FIELDS = {
    env_name: 'envName', friendly_name: 'friendlyName', metadata: 'metadata',
    launch_recipe: 'launchRecipe', fleet_id: 'fleetId', process_state: 'processState',
    session_id: 'sessionId', session_path: 'sessionPath',
  }
  return {
    rows: store.rows,
    writes: [],
    ensure(id) { store.rows[id] = store.rows[id] || { mintId: id } },
    get: id => store.rows[id] || null,
    resolve: id => store.rows[id] || null,
    setFact(id, field, value) {
      // Both routes to the process fact are counted. mint-core writes a first
      // one through setFact and later ones through updateProcessState, and a
      // "refused before any write" claim has to cover both.
      if (field === 'process_state') this.writes.push({ id, processState: value })
      store.rows[id] = { ...store.rows[id], [FIELDS[field] || field]: value }
    },
    updateLaunchRecipe(id, recipe) { store.rows[id] = { ...store.rows[id], launchRecipe: recipe } },
    updateFriendlyName(id, name) { store.rows[id] = { ...store.rows[id], friendlyName: name } },
    updateProcessState(id, processState) {
      this.writes.push({ id, processState })
      store.rows[id] = { ...store.rows[id], processState }
      return store.rows[id]
    },
    updateSessionFacts(id, { sessionId, sessionPath }) {
      store.rows[id] = { ...store.rows[id], sessionId, sessionPath }
    },
    markJoined(id) {
      store.rows[id] = { ...store.rows[id], joinedAt: '2026-09-08T12:00:00Z' }
      return store.rows[id]
    },
  }
}

// One box, one daemon, assembled the way fleet-daemon.mjs assembles them.
function daemon({
  row,
  sessions = [LIVE, 'fleet-someone-else'],
  runtimes = { [LIVE]: { probed: true, runtime: true, fleetId: 'fleet:recovered-runtime', envName: 'testing', daemonKey: 'mini:testing' } },
  ledger = [],
  // What the harness session resolver reads off the running process: the
  // rollout it actually has open. In the daemon this is
  // `resolveLiveCodexSessionIdentity`, PID-owned rather than by launch window.
  harnessSessions = { [LIVE]: { sessionId: 'session-live', jsonlPath: '/rollouts/session-live.jsonl' } },
  config = CONFIG,
  withRecipeFallback = true,
  withConflictRefusal = true,
}) {
  const calls = { launched: 0, seats: 0, names: 0, resumed: 0, bound: [], recovered: 0 }
  const store = memoryStore({ 'mint-1': row })

  const core = createDaemonMintCore({
    store,
    envName: 'testing',
    processAlive: async facts => !!runtimes[facts.processState?.tmux_session]?.runtime,
    launchProcess: async () => {
      calls.launched += 1
      calls.names += 1
      throw new Error('a live runtime was spawned over')
    },
    requestSeat: async () => { calls.seats += 1; return { fleet_id: 'fleet:newly-allocated' } },
    // The real bind: it reads the grant off the process fact, which is the read
    // that used to happen after the write and find null.
    bindSeat: async facts => {
      const grant = facts.processState?.permission_grant
      if (!grant) throw new Error('SPAWN_PERMISSION_LEDGER_MISSING_GRANT: permission ledger grant is required')
      calls.bound.push({ fleetId: facts.fleetId, grant })
    },
  })

  const observeRuntimeIdentity = async candidate => {
    const rows = ledger.filter(entry => entry.tmuxSession === candidate.tmuxSession)
    const binding = candidate.binding || rows[0] || null
    const live = harnessSessions[candidate.tmuxSession] || null
    return {
      fleetId: candidate.probe?.fleetId || binding?.id || null,
      sessionId: live?.sessionId || binding?.sessionId || null,
      sessionPath: live?.jsonlPath || binding?.sessionPath || null,
      friendlyName: binding?.friendlyName || null,
      cwd: binding?.cwd || null,
      harness: binding?.sessionKind || null,
      model: binding?.model || null,
      envName: candidate.probe?.envName || binding?.envName || null,
      daemonKey: candidate.probe?.daemonKey || binding?.daemonKey || null,
      permissionGrant: binding?.permissionGrant || null,
      ledgerBindsSingleRuntime: rows.length === 1,
      strongFieldSources: {
        fleetId: candidate.probe?.fleetId ? 'runtime-argv' : (binding?.id ? 'ledger' : null),
        sessionId: live?.sessionId ? 'harness-runtime' : (binding?.sessionId ? 'ledger' : null),
      },
    }
  }

  const expectedIdentity = facts => ({
    fleetId: facts.fleetId,
    mintId: facts.mintId,
    sessionId: facts.sessionId,
    friendlyName: facts.friendlyName,
    cwd: facts.processState?.cwd || facts.launchRecipe?.cwd,
    harness: facts.processState?.harness || facts.launchRecipe?.kind,
    model: facts.processState?.model || facts.launchRecipe?.model,
    envName: facts.envName,
    daemonKey: 'mini:testing',
  })

  const recoverExistingRuntime = async facts => {
    calls.recovered += 1
    const decision = await resolvePartialMintRuntime({
      facts,
      expectedIdentity,
      candidateSessions: f => {
        const found = []
        const bound = ledger.find(entry => entry.id === f.fleetId)
        if (bound?.tmuxSession) found.push({ tmuxSession: bound.tmuxSession, source: 'ledger-fleet-id', binding: bound })
        found.push({ tmuxSession: `fleet-${f.friendlyName}`, source: 'launch-recipe-session' })
        return found
      },
      listSessions: async () => ({ probed: true, names: sessions }),
      probeSession: async session => runtimes[session] || { probed: true, runtime: false },
      observeRuntimeIdentity,
    })
    const adopting = decision.action === 'rebind' || decision.action === 'enrich'
    if (!adopting) return decision

    const observed = decision.observed || {}
    const authority = resolvePartialMintPermissionAuthority({
      ledgerGrant: observed.permissionGrant || null,
      ledgerBindsSingleRuntime: !!observed.ledgerBindsSingleRuntime,
      // The counterfactual switches: dropping the recipe fallback is what put a
      // null grant on the process fact, and dropping the conflict refusal is
      // what let two disagreeing authorities be written through.
      recipeGrant: withRecipeFallback ? (facts.launchRecipe?.permissionGrant ?? null) : null,
      normalizeGrant: grant => normalizePermissionGrant(grant, config),
    })
    // Each switch removes one guard and lets the path continue exactly as the
    // original code did: write whatever grant was observed, and find out at
    // bind time. That is the failure being reproduced, so the refusal has to be
    // bypassed rather than merely unreachable.
    const suppressed = new Set([
      ...(withRecipeFallback ? [] : ['no-grant-authority']),
      ...(withConflictRefusal ? [] : ['grant-authority-disagreement']),
    ])
    if (!authority.ok && !suppressed.has(authority.reason)) {
      return { action: 'hold', reason: authority.reason, session: decision.session, detail: authority.detail || null }
    }

    const expected = expectedIdentity(facts)
    const recorded = facts.processState || {}
    const enriching = decision.action === 'enrich'
    const processFact = {
      ...recorded,
      mint_id: recorded.mint_id || facts.mintId,
      fleet_id: recorded.fleet_id || expected.fleetId || observed.fleetId || null,
      name: recorded.name || facts.friendlyName || observed.friendlyName || null,
      tmux_session: enriching ? recorded.tmux_session : decision.session,
      cwd: recorded.cwd || observed.cwd || expected.cwd || null,
      harness: recorded.harness || observed.harness || expected.harness || null,
      model: recorded.model || observed.model || expected.model || null,
      session_id: recorded.session_id || observed.sessionId || facts.sessionId || null,
      session_path: recorded.session_path || observed.sessionPath || facts.sessionPath || null,
      permission_grant: authority.ok ? authority.grant : (observed.permissionGrant || null),
      machine_id: recorded.machine_id || 'mini',
      env_name: recorded.env_name || 'testing',
      daemon_key: recorded.daemon_key || 'mini:testing',
      alive: true,
    }
    const rebound = await core.recordProcess(facts.mintId, processFact)
    return {
      action: enriching ? 'enriched' : 'rebound',
      reason: decision.reason,
      session: processFact.tmux_session,
      grantSource: authority.source,
      facts: rebound,
    }
  }

  const wake = createDaemonWakeCore({
    store,
    processAlive: async facts => !!runtimes[facts.processState?.tmux_session]?.runtime,
    resumeSession: async () => { calls.resumed += 1; return { tmux_session: 'fleet-half-minted-2' } },
    recoverExistingRuntime,
  })

  return { store, core, wake, calls, recoverExistingRuntime }
}

const NULL_PROCESS_ROW = {
  mintId: 'mint-1',
  fleetId: 'fleet:recovered-runtime',
  friendlyName: 'half-minted',
  launchRecipe: RECIPE,
  envName: 'testing',
  joinedAt: null,
}

const ALREADY_PARTIAL_ROW = {
  ...NULL_PROCESS_ROW,
  processState: { ...RECORDED_PROCESS },
  sessionId: 'session-live',
  sessionPath: '/rollouts/session-live.jsonl',
}

const LEDGER_ROW = {
  id: 'fleet:recovered-runtime',
  friendlyName: 'half-minted',
  tmuxSession: LIVE,
  sessionKind: 'codex',
  sessionId: 'session-live',
  sessionPath: '/rollouts/session-live.jsonl',
  model: 'opus',
  cwd: CWD,
  envName: 'testing',
  daemonKey: 'mini:testing',
}

// 1. No process state, no ledger row, and a recipe that names `app-dev`. The
//    runtime is matched and adopted, and the grant comes from the recipe --
//    which is the case that used to write null and fail the bind afterwards.
{
  const { wake, store, calls } = daemon({ row: { ...NULL_PROCESS_ROW } })
  const result = await wake({ mint_id: 'mint-1' })

  assert.equal(result.ok, true)
  assert.equal(result.rebound, true)
  assert.equal(store.get('mint-1').processState.tmux_session, LIVE)
  assert.equal(store.get('mint-1').processState.permission_grant, 'app-dev')
  assert.equal(store.get('mint-1').joinedAt, '2026-09-08T12:00:00Z', 'the bind that used to fail on a null grant')
  assert.deepEqual(calls.bound, [{ fleetId: 'fleet:recovered-runtime', grant: 'app-dev' }])
  assert.equal(calls.launched, 0)
  assert.equal(calls.resumed, 0)
  assert.equal(calls.seats, 0)
  assert.equal(calls.names, 0)
}

// 2. The already-partial shape: the real tmux, PID and session are in process
//    state, the grant is null, joined_at is null, and there is no ledger row.
//    It completes in place -- same process fact enriched, nothing allocated,
//    no identity field moved -- and calling it again does nothing at all.
{
  const { wake, store, calls } = daemon({ row: { ...ALREADY_PARTIAL_ROW } })
  const result = await wake({ mint_id: 'mint-1' })

  assert.equal(result.ok, true)
  assert.equal(result.enriched, true, 'this is a completion in place, not an adoption')

  const process = store.get('mint-1').processState
  assert.equal(process.permission_grant, 'app-dev', 'the missing fact, filled from the durable recipe')
  for (const field of ['mint_id', 'fleet_id', 'name', 'tmux_session', 'pid', 'cwd', 'harness', 'model', 'session_id', 'session_path', 'machine_id', 'env_name', 'daemon_key']) {
    assert.equal(process[field], RECORDED_PROCESS[field], `${field} must not be rewritten`)
  }
  assert.equal(store.get('mint-1').joinedAt, '2026-09-08T12:00:00Z')
  assert.deepEqual(calls.bound, [{ fleetId: 'fleet:recovered-runtime', grant: 'app-dev' }])
  assert.equal(calls.launched, 0)
  assert.equal(calls.resumed, 0)
  assert.equal(calls.seats, 0)
  assert.equal(calls.names, 0)

  // Idempotent: the row is joined now, so a second wake is the ordinary
  // already-alive answer and the recovery is not consulted at all.
  const writesAfterFirst = store.writes.length
  const recoveredAfterFirst = calls.recovered
  const again = await wake({ mint_id: 'mint-1' })
  assert.equal(again.ok, true)
  assert.equal(again.alreadyAlive, true)
  assert.equal(again.enriched, undefined, 'nothing left to complete')
  assert.equal(store.writes.length, writesAfterFirst, 'a no-op writes nothing')
  assert.equal(calls.recovered, recoveredAfterFirst, 'a joined row is not offered to the recovery')
  assert.equal(calls.launched + calls.resumed + calls.seats + calls.names, 0)
}

// 3. A coherent ledger binding whose grant equals the recipe's. It succeeds,
//    and the ledger is the authority that supplied it.
{
  const { recoverExistingRuntime, store } = daemon({
    row: { ...NULL_PROCESS_ROW },
    ledger: [{ ...LEDGER_ROW, permissionGrant: 'app-dev' }],
  })
  const outcome = await recoverExistingRuntime(store.get('mint-1'))
  assert.equal(outcome.action, 'rebound')
  assert.equal(outcome.grantSource, 'ledger-binding')
  assert.equal(store.get('mint-1').processState.permission_grant, 'app-dev')
}

// 4. Two authorities that do not agree. Refused, and refused before anything is
//    written -- the store is untouched, which is the ordering this repair is
//    about. Neither grant is picked; a tie is not broken.
{
  const { recoverExistingRuntime, store, calls } = daemon({
    row: { ...NULL_PROCESS_ROW },
    ledger: [{ ...LEDGER_ROW, permissionGrant: 'ops' }],
  })
  const outcome = await recoverExistingRuntime(store.get('mint-1'))
  assert.equal(outcome.action, 'hold')
  assert.equal(outcome.reason, 'grant-authority-disagreement')
  assert.deepEqual(store.writes, [], 'refused before the write, not after it')
  assert.equal(store.get('mint-1').processState, undefined)
  assert.deepEqual(calls.bound, [])
  assert.equal(calls.launched, 0)
}

// 5. Neither authority exists: no ledger row, and a recipe carrying no grant.
//    There is no answer to what permissions this runtime holds, so there is
//    nothing to bind it under and nothing is written.
{
  const { recoverExistingRuntime, store, calls } = daemon({
    row: { ...NULL_PROCESS_ROW, launchRecipe: { kind: 'codex', cwd: CWD, model: 'opus' } },
  })
  const outcome = await recoverExistingRuntime(store.get('mint-1'))
  assert.equal(outcome.action, 'hold')
  assert.equal(outcome.reason, 'no-grant-authority')
  assert.deepEqual(store.writes, [])
  assert.deepEqual(calls.bound, [])
}

// 6. A recipe naming a profile this daemon has no configuration for. It refuses
//    rather than resolving to something else: a recipe whose intent cannot be
//    honoured must not be quietly honoured as some other intent.
{
  const { recoverExistingRuntime, store, calls } = daemon({
    row: { ...NULL_PROCESS_ROW, launchRecipe: { ...RECIPE, permissionGrant: 'retired-profile' } },
  })
  const outcome = await recoverExistingRuntime(store.get('mint-1'))
  assert.equal(outcome.action, 'hold')
  assert.equal(outcome.reason, 'recipe-grant-invalid')
  assert.match(outcome.detail, /unknown permission profile "retired-profile"/)
  assert.deepEqual(store.writes, [])
  assert.deepEqual(calls.bound, [])
}

// 7. Permission authority repairs a binding; it does not repair a runtime. A
//    dead, unprobed, or wrongly-identified session refuses exactly as before,
//    and a perfectly good grant does not rescue any of them.
{
  // Dead: the recorded session exists and nothing is running in it.
  const dead = daemon({
    row: { ...ALREADY_PARTIAL_ROW },
    runtimes: { [LIVE]: { probed: true, runtime: false } },
  })
  const deadOutcome = await dead.recoverExistingRuntime(dead.store.get('mint-1'))
  assert.equal(deadOutcome.action, 'launch', 'a confirmed-dead runtime follows the existing replacement policy')
  assert.deepEqual(dead.store.writes, [])

  // Unprobed: the probe could not complete. Not looking is not evidence.
  const unprobed = daemon({
    row: { ...ALREADY_PARTIAL_ROW },
    runtimes: { [LIVE]: { probed: false, runtime: false } },
  })
  const unprobedOutcome = await unprobed.recoverExistingRuntime(unprobed.store.get('mint-1'))
  assert.equal(unprobedOutcome.action, 'hold')
  assert.equal(unprobedOutcome.reason, 'runtime-unprobed')
  assert.deepEqual(unprobed.store.writes, [])

  // Conflicting: something is running there, carrying somebody else's FLEET_ID.
  const conflicting = daemon({
    row: { ...ALREADY_PARTIAL_ROW },
    runtimes: { [LIVE]: { probed: true, runtime: true, fleetId: 'fleet:conflicting-runtime', envName: 'testing', daemonKey: 'mini:testing' } },
  })
  const conflictOutcome = await conflicting.recoverExistingRuntime(conflicting.store.get('mint-1'))
  assert.equal(conflictOutcome.action, 'hold')
  assert.equal(conflictOutcome.reason, 'identity-conflict')
  assert.deepEqual(conflicting.store.writes, [])
}

// ---------------------------------------------------------------------------
// Counterfactuals, built into the suite rather than applied to the source.

// 8. Remove the recipe fallback and control 1 reproduces the original failure:
//    a null grant written onto the process fact, and the bind rejecting after
//    the write. Without this, control 1 proves nothing about where the grant
//    came from.
{
  const { recoverExistingRuntime, store } = daemon({
    row: { ...NULL_PROCESS_ROW },
    withRecipeFallback: false,
  })
  await assert.rejects(
    () => recoverExistingRuntime(store.get('mint-1')),
    /SPAWN_PERMISSION_LEDGER_MISSING_GRANT/,
    'with no recipe authority there is no grant, and the bind fails as it originally did',
  )
  assert.equal(store.writes.length, 1, 'and it failed AFTER the process fact was written')
  assert.equal(store.get('mint-1').processState.permission_grant, null)
  assert.equal(store.get('mint-1').joinedAt, null, 'left recorded, unbound, and unjoined')
}

// 9. Remove the conflict refusal and control 4 writes through: the mint is bound
//    under a grant that its own two records disagree about.
{
  const { recoverExistingRuntime, store, calls } = daemon({
    row: { ...NULL_PROCESS_ROW },
    ledger: [{ ...LEDGER_ROW, permissionGrant: 'ops' }],
    withConflictRefusal: false,
  })
  const outcome = await recoverExistingRuntime(store.get('mint-1'))
  assert.equal(outcome.action, 'rebound', 'without the refusal the disagreement is written through')
  assert.equal(store.get('mint-1').processState.permission_grant, 'ops')
  assert.equal(calls.bound.length, 1)
}

console.log('a recovered runtime binds under an issued grant: ok')
