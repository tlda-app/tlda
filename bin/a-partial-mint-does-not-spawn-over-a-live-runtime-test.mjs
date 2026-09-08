#!/usr/bin/env node
// A mint row with no `process_state` used to be read as "no process", because
// the only thing that could answer "is one running" started at
// `facts.processState.tmux_session`. Finishing such a row therefore spawned a
// second harness beside the live one, took a rotated `-2` session name for it,
// and left the original agent running under a row that pointed at nothing.
//
// The decisions this checks are the three the recovery can reach, and the two
// that refuse are the reason it exists: not looking is not evidence of absence,
// and two candidates that both fit is not a candidate.
import assert from 'node:assert/strict'
import {
  adoptionVerdict,
  resolvePartialMintRuntime,
} from '../daemon/partial-mint-runtime-recovery.mjs'
import { createDaemonMintCore } from '../daemon/mint-core.mjs'
import { createDaemonWakeCore } from '../daemon/wake-core.mjs'

const RECIPE = { kind: 'codex', cwd: '/Users/skip/work/tlda', model: 'opus' }

const MINT = {
  mintId: 'mint-1',
  fleetId: 'fleet:a8196c6d',
  friendlyName: 'half-minted',
  launchRecipe: RECIPE,
  envName: 'testing',
  processState: null,
  sessionId: null,
}

const OWN_IDENTITY = {
  fleetId: 'fleet:a8196c6d',
  sessionId: 'session-live',
  sessionPath: '/rollouts/session-live.jsonl',
  friendlyName: 'half-minted',
  cwd: '/Users/skip/work/tlda',
  harness: 'codex',
  model: 'opus',
  envName: 'testing',
  daemonKey: 'mini:testing',
  // Read off the running process and its open rollout: evidence about the
  // runtime, not about a row that describes it.
  strongFieldSources: { fleetId: 'runtime-argv', sessionId: 'harness-runtime' },
  ledgerBindsSingleRuntime: true,
}

function recovery({
  facts = MINT,
  candidates = [{ tmuxSession: 'fleet-half-minted', source: 'launch-recipe-session' }],
  sessions = { probed: true, names: ['fleet-half-minted'] },
  probes = { 'fleet-half-minted': { probed: true, runtime: true } },
  observed = OWN_IDENTITY,
  expected = null,
} = {}) {
  const asked = { probed: [], observed: 0 }
  return {
    asked,
    run: () => resolvePartialMintRuntime({
      facts,
      expectedIdentity: () => expected || {
        fleetId: facts.fleetId,
        mintId: facts.mintId,
        sessionId: facts.sessionId,
        friendlyName: facts.friendlyName,
        cwd: facts.launchRecipe?.cwd,
        harness: facts.launchRecipe?.kind,
        model: facts.launchRecipe?.model,
        envName: facts.envName,
        daemonKey: 'mini:testing',
      },
      candidateSessions: () => candidates,
      listSessions: async () => sessions,
      probeSession: async session => {
        asked.probed.push(session)
        return probes[session] || { probed: true, runtime: false }
      },
      observeRuntimeIdentity: async candidate => {
        asked.observed += 1
        return typeof observed === 'function' ? observed(candidate) : observed
      },
    }),
  }
}

// 1. The incident. One live candidate whose identity is the mint's own: adopt
//    it. Nothing is spawned, no name is allocated, no seat is requested -- the
//    decision itself carries no launch.
{
  const { run } = recovery()
  const decision = await run()
  assert.equal(decision.action, 'rebind')
  assert.equal(decision.session, 'fleet-half-minted')
  assert.match(decision.reason, /^identity:/, 'a fleet-id match is identity evidence, not arrangement')
  assert.deepEqual(decision.verdict.conflicts, [])
}

// 2. Proven absence. tmux answered, and the session the recipe would have used
//    is not among the ones that exist. This is the branch that must still
//    launch, and it is why `hold` cannot be spelled `launch`.
{
  const { run, asked } = recovery({ sessions: { probed: true, names: ['fleet-someone-else'] } })
  const decision = await run()
  assert.equal(decision.action, 'launch')
  assert.equal(decision.reason, 'absence-proven')
  assert.deepEqual(asked.probed, [], 'a session that does not exist is not probed for a runtime')
}

// 3. Confirmed dead. The session exists and tmux looked inside it: nothing is
//    running. That is the existing wake replacement case, so recovery stands
//    aside rather than inventing a second policy for it.
{
  const { run } = recovery({ probes: { 'fleet-half-minted': { probed: true, runtime: false } } })
  const decision = await run()
  assert.equal(decision.action, 'launch')
  assert.equal(decision.reason, 'runtime-confirmed-dead')
}

// 4. Could not look at tmux at all. `list-sessions` failing for any reason
//    other than "no server running" is not an observation of absence.
{
  const { run } = recovery({ sessions: { probed: false, names: [] } })
  const decision = await run()
  assert.equal(decision.action, 'hold')
  assert.equal(decision.reason, 'tmux-unobserved')
}

// 5. The session exists and the runtime probe could not complete -- a `ps` that
//    blew its timeout, likeliest exactly when the box is loaded. `probed:false`
//    holds; it never falls through to a spawn.
{
  const { run } = recovery({ probes: { 'fleet-half-minted': { probed: false, runtime: false } } })
  const decision = await run()
  assert.equal(decision.action, 'hold')
  assert.equal(decision.reason, 'runtime-unprobed')
}

// 6. Two live sessions both fit. Neither may be adopted: picking one is a
//    guess, and spawning is worse.
{
  const { run, asked } = recovery({
    candidates: [
      { tmuxSession: 'fleet-half-minted', source: 'launch-recipe-session' },
      { tmuxSession: 'fleet-half-minted-2', source: 'ledger-friendly-name' },
    ],
    sessions: { probed: true, names: ['fleet-half-minted', 'fleet-half-minted-2'] },
    probes: {
      'fleet-half-minted': { probed: true, runtime: true },
      'fleet-half-minted-2': { probed: true, runtime: true },
    },
  })
  const decision = await run()
  assert.equal(decision.action, 'hold')
  assert.equal(decision.reason, 'ambiguous-candidates')
  assert.deepEqual(decision.sessions, ['fleet-half-minted', 'fleet-half-minted-2'])
  assert.equal(asked.observed, 0, 'an ambiguous set is refused before any identity is resolved')
}

// 7. One live session, and it belongs to somebody else. Every arrangement field
//    agrees -- same name, same cwd, same harness, same box -- and the FLEET_ID
//    the process carries does not. Binding here would take a running agent's
//    identity away from it.
{
  const { run } = recovery({ observed: { ...OWN_IDENTITY, fleetId: 'fleet:c07dedea' } })
  const decision = await run()
  assert.equal(decision.action, 'hold')
  assert.equal(decision.reason, 'identity-conflict')
  assert.deepEqual(decision.verdict.conflicts, [
    { field: 'fleetId', expected: 'fleet:a8196c6d', observed: 'fleet:c07dedea' },
  ])
}

// 8. The narrowing. A live session that matches on friendly name and cwd and
//    nothing else is not this agent: those are shared by every agent launched
//    the same way. Name, cwd, or launch window alone cannot authorize adoption.
{
  const { run } = recovery({
    facts: { ...MINT, fleetId: null },
    observed: {
      fleetId: null,
      sessionId: null,
      friendlyName: 'half-minted',
      cwd: '/Users/skip/work/tlda',
      harness: null,
      model: null,
      envName: null,
      daemonKey: null,
    },
  })
  const decision = await run()
  assert.equal(decision.action, 'hold')
  assert.equal(decision.reason, 'insufficient-identity-evidence')
  assert.deepEqual(decision.verdict.missing, ['harness', 'model', 'envName', 'daemonKey'])
}

// 9. Control for 8 -- the same absent fleet id, with the whole arrangement
//    tuple observed and agreeing. One coherent tuple, nothing contradicting it,
//    one candidate: that is an adoption. This is what keeps the narrowing from
//    quietly meaning "never adopt without a fleet id".
{
  const { run } = recovery({
    facts: { ...MINT, fleetId: null },
    observed: { ...OWN_IDENTITY, fleetId: null, sessionId: null },
  })
  const decision = await run()
  assert.equal(decision.action, 'rebind')
  assert.equal(decision.reason, 'coherent-tuple')
}

// 10. A finished row is not this path's business. Recorded process state used
//     to be the test for that, and it was the wrong one: the half-made row
//     carries a live runtime with no grant and no join, so "has process state"
//     excluded from repair exactly the row that most needed it. The join is
//     what says finished, and mint-core sets it only after bindSeat succeeds.
{
  const { run, asked } = recovery({
    facts: {
      ...MINT,
      processState: { tmux_session: 'fleet-half-minted' },
      joinedAt: '2026-09-08T10:00:00Z',
    },
  })
  const decision = await run()
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'already-joined')
  assert.deepEqual(asked.probed, [])
}

// 11. One session named by two sources is one candidate, not an ambiguity.
{
  const { run } = recovery({
    candidates: [
      { tmuxSession: 'fleet-half-minted', source: 'ledger-fleet-id' },
      { tmuxSession: 'fleet-half-minted', source: 'launch-recipe-session' },
    ],
  })
  const decision = await run()
  assert.equal(decision.action, 'rebind')
  assert.deepEqual(decision.examined[0].sources, ['ledger-fleet-id', 'launch-recipe-session'])
}

// 12. The verdict on its own: an unknown field is unknown, never agreement.
{
  const verdict = adoptionVerdict(
    { fleetId: null, friendlyName: 'a', cwd: '/w', harness: 'codex', model: 'opus', envName: 'testing', daemonKey: 'mini:testing' },
    { fleetId: 'fleet:x', friendlyName: 'a', cwd: '/w', harness: 'codex', model: 'opus', envName: 'testing', daemonKey: 'mini:testing' },
  )
  assert.equal(verdict.ok, true)
  assert.equal(verdict.basis, 'coherent-tuple')
  assert.ok(verdict.unknown.includes('fleetId'), 'a fleet id only one side knows is not a match')
}

// 13. A fleet id that came out of the permission ledger rather than off the
//     process. It identifies the runtime only while that row is the one row
//     bound to it -- so with a coherent single binding it carries the adoption.
{
  const { run } = recovery({
    observed: {
      ...OWN_IDENTITY,
      sessionId: null,
      strongFieldSources: { fleetId: 'ledger', sessionId: null },
      ledgerBindsSingleRuntime: true,
    },
  })
  const decision = await run()
  assert.equal(decision.action, 'rebind')
  assert.equal(decision.reason, 'identity:fleetId')
}

// 14. The same ledger-derived fleet id, from a ledger that has drifted from the
//     box -- two rows naming one tmux session, so the row is bookkeeping rather
//     than evidence about the process. It is demoted, and with the arrangement
//     tuple incomplete there is nothing left to adopt on. This is the Claude
//     case: no FLEET_ID in the command for the probe to read.
{
  const { run } = recovery({
    observed: {
      ...OWN_IDENTITY,
      sessionId: null,
      model: null,
      daemonKey: null,
      strongFieldSources: { fleetId: 'ledger', sessionId: null },
      ledgerBindsSingleRuntime: false,
    },
  })
  const decision = await run()
  assert.equal(decision.action, 'hold')
  assert.equal(decision.reason, 'insufficient-identity-evidence')
  assert.deepEqual(decision.verdict.demoted, ['fleetId'], 'a drifted ledger row is not identity evidence')
  assert.deepEqual(decision.verdict.missing, ['model', 'daemonKey'])
}

// 15. Control for 14 -- the demotion is not a waiver. A ledger-derived fleet id
//     that DISAGREES still refuses, ahead of anything the tuple says.
{
  const { run } = recovery({
    observed: {
      ...OWN_IDENTITY,
      fleetId: 'fleet:c07dedea',
      strongFieldSources: { fleetId: 'ledger', sessionId: 'harness-runtime' },
      ledgerBindsSingleRuntime: false,
    },
  })
  const decision = await run()
  assert.equal(decision.action, 'hold')
  assert.equal(decision.reason, 'identity-conflict', 'a demoted field is still a compared field')
}

// 16. Control for 14 the other way -- drifted ledger, but every arrangement
//     field observed and agreeing. The demotion costs the shortcut, not the
//     adoption.
{
  const { run } = recovery({
    observed: {
      ...OWN_IDENTITY,
      sessionId: null,
      strongFieldSources: { fleetId: 'ledger', sessionId: null },
      ledgerBindsSingleRuntime: false,
    },
  })
  const decision = await run()
  assert.equal(decision.action, 'rebind')
  assert.equal(decision.reason, 'coherent-tuple')
  assert.deepEqual(decision.verdict.demoted, ['fleetId'])
}

// ---------------------------------------------------------------------------
// mint-core: the decision has to reach the launcher.

function memoryStore(rows = {}) {
  const store = { rows: { ...rows } }
  return {
    rows: store.rows,
    ensure: id => { store.rows[id] = store.rows[id] || { mintId: id } },
    get: id => store.rows[id] || null,
    resolve: id => store.rows[id] || null,
    setFact: (id, field, value) => {
      const key = { env_name: 'envName', friendly_name: 'friendlyName', metadata: 'metadata', launch_recipe: 'launchRecipe', fleet_id: 'fleetId', process_state: 'processState', session_id: 'sessionId', session_path: 'sessionPath' }[field] || field
      store.rows[id] = { ...store.rows[id], [key]: value }
    },
    updateLaunchRecipe: (id, recipe) => { store.rows[id] = { ...store.rows[id], launchRecipe: recipe } },
    updateFriendlyName: (id, name) => { store.rows[id] = { ...store.rows[id], friendlyName: name } },
    updateProcessState: (id, processState) => {
      store.rows[id] = { ...store.rows[id], processState }
      return store.rows[id]
    },
    updateSessionFacts: (id, { sessionId, sessionPath }) => {
      store.rows[id] = { ...store.rows[id], sessionId, sessionPath }
    },
    markJoined: id => {
      store.rows[id] = { ...store.rows[id], joinedAt: '2026-09-08T11:00:00Z' }
      return store.rows[id]
    },
  }
}

function mintHarness({ row, recoverExistingRuntime }) {
  const calls = { launched: 0, seats: 0, bound: 0, recovered: 0 }
  const store = memoryStore(row ? { 'mint-1': row } : {})
  const core = createDaemonMintCore({
    store,
    envName: 'testing',
    processAlive: async () => true,
    launchProcess: async params => {
      calls.launched += 1
      return {
        mint_id: params.mint_id,
        fleet_id: params.fleet_id || 'fleet:fresh',
        name: params.name,
        tmux_session: `fleet-${params.name}-${calls.launched + 1}`,
        cwd: RECIPE.cwd,
        harness: 'codex',
        model: 'opus',
        session_id: 'session-fresh',
      }
    },
    requestSeat: async () => {
      calls.seats += 1
      return { fleet_id: 'fleet:seat', friendly_name: 'half-minted' }
    },
    bindSeat: async () => { calls.bound += 1 },
    recoverExistingRuntime: recoverExistingRuntime
      ? async facts => { calls.recovered += 1; return recoverExistingRuntime(facts, store) }
      : null,
  })
  return { core, store, calls }
}

const PARTIAL_ROW = {
  mintId: 'mint-1',
  fleetId: 'fleet:a8196c6d',
  friendlyName: 'half-minted',
  launchRecipe: RECIPE,
  envName: 'testing',
}

const rebindTo = (facts, store) => {
  store.updateProcessState(facts.mintId, {
    mint_id: facts.mintId,
    fleet_id: facts.fleetId,
    name: facts.friendlyName,
    tmux_session: 'fleet-half-minted',
    cwd: RECIPE.cwd,
    harness: 'codex',
    model: 'opus',
    session_id: 'session-live',
  })
  store.updateSessionFacts(facts.mintId, { sessionId: 'session-live', sessionPath: '/rollouts/session-live.jsonl' })
  return { action: 'rebound', facts: store.get(facts.mintId) }
}

// 17. A reused partial row whose runtime is already live: the mint completes
//     with zero launches, zero seat requests, and the live session recorded.
{
  const { core, store, calls } = mintHarness({ row: PARTIAL_ROW, recoverExistingRuntime: rebindTo })
  const facts = await core.mint({ mint_id: 'mint-1', name: 'half-minted', launch: RECIPE })
  assert.equal(calls.recovered, 1)
  assert.equal(calls.launched, 0, 'a live runtime must not be spawned over')
  assert.equal(calls.seats, 0, 'adoption allocates no seat')
  assert.equal(store.get('mint-1').processState.tmux_session, 'fleet-half-minted')
  assert.equal(facts.joinedAt, '2026-09-08T11:00:00Z')
  assert.equal(calls.bound, 1, 'the existing seat is bound, not a new one')
}

// 18. Counterfactual for 17, and the positive control for this whole file: the
//     same row and the same store with the recovery absent. If this does not
//     spawn, 13 proves nothing about the fix.
{
  const { core, calls } = mintHarness({ row: PARTIAL_ROW, recoverExistingRuntime: null })
  await core.mint({ mint_id: 'mint-1', name: 'half-minted', launch: RECIPE })
  assert.equal(calls.launched, 1, 'without the recovery this path is exactly the duplicate spawn')
}

// 19. Proven absence launches, and launches once.
{
  const { core, calls } = mintHarness({
    row: PARTIAL_ROW,
    recoverExistingRuntime: () => ({ action: 'launch', reason: 'absence-proven' }),
  })
  await core.mint({ mint_id: 'mint-1', name: 'half-minted', launch: RECIPE })
  assert.equal(calls.launched, 1)
}

// 20. A hold refuses the mint. It does not launch, and it says which session it
//     could not settle.
{
  const { core, calls } = mintHarness({
    row: PARTIAL_ROW,
    recoverExistingRuntime: () => ({ action: 'hold', reason: 'runtime-unprobed', session: 'fleet-half-minted' }),
  })
  await assert.rejects(
    () => core.mint({ mint_id: 'mint-1', name: 'half-minted', launch: RECIPE }),
    /refused: runtime-unprobed \(fleet-half-minted\)/,
  )
  assert.equal(calls.launched, 0, 'an unsettled candidate is never spawned over')
  assert.equal(calls.seats, 0)
}

// 21. A mint id the store has never seen is a new agent, not a partial row. The
//     recovery is not consulted at all -- otherwise a live session belonging to
//     another agent of the same requested name would read as a collision to
//     refuse, where the seat allocator is what resolves that.
{
  const { core, calls } = mintHarness({ row: null, recoverExistingRuntime: rebindTo })
  await core.mint({ mint_id: 'mint-1', name: 'half-minted', launch: RECIPE })
  assert.equal(calls.recovered, 0, 'a row this call created has no runtime to recover')
  assert.equal(calls.launched, 1)
}

// ---------------------------------------------------------------------------
// wake-core: the same three decisions, on the path that was the other half of
// the incident.

function wakeHarness({ recoverExistingRuntime, liveSessions = ['fleet-half-minted', 'fleet-half-minted-2'], joinedAt = null }) {
  const calls = { resumed: 0, recovered: 0 }
  const live = new Set(liveSessions)
  // Not joined. The recovery is offered every row that has not finished
  // joining, which is what lets it reach the half-made row whose process state
  // is recorded; a joined row is finished and skips it (case 28).
  const store = memoryStore({ 'mint-1': { ...PARTIAL_ROW, joinedAt } })
  const wake = createDaemonWakeCore({
    store,
    // Shaped like the daemon's: it looks up the recorded session on the box and
    // knows nothing else. A harness that closes over an `alive` flag instead
    // cannot tell whether the confirmation looked at the facts the wake
    // produced or at the stale ones it started from, and cannot tell a session
    // that is recorded from one that is running -- both differences are under
    // test here.
    processAlive: async facts => live.has(facts.processState?.tmux_session),
    resumeSession: async () => {
      calls.resumed += 1
      return { tmux_session: 'fleet-half-minted-2' }
    },
    recoverExistingRuntime: async facts => { calls.recovered += 1; return recoverExistingRuntime(facts, store) },
  })
  return { wake, store, calls }
}

// 22. Waking a partial row whose runtime is already up returns that agent as
//     awake. It does not relaunch it under a rotated name.
{
  const { wake, calls } = wakeHarness({ recoverExistingRuntime: rebindTo })
  const result = await wake({ mint_id: 'mint-1' })
  assert.equal(result.ok, true)
  assert.equal(result.rebound, true)
  assert.equal(result.alreadyAlive, true)
  assert.equal(result.processState.tmux_session, 'fleet-half-minted')
  assert.equal(calls.resumed, 0, 'the runtime is already live; resuming would be the duplicate')
}

// 23. A hold refuses the wake without resuming.
{
  const { wake, calls } = wakeHarness({
    recoverExistingRuntime: () => ({ action: 'hold', reason: 'ambiguous-candidates', sessions: ['a', 'b'] }),
  })
  await assert.rejects(
    () => wake({ mint_id: 'mint-1' }),
    /wake refused for mint mint-1: ambiguous-candidates \(a, b\)/,
  )
  assert.equal(calls.resumed, 0)
}

// 24. Proven absence falls through to the wake that was already there: the
//     partial row is finished from its recipe, exactly once. The confirmation
//     reads the session the resume just produced, not the empty process state
//     the row carried into the call -- which is what used to make a successful
//     partial-mint resume report `wake did not produce a live runtime`.
{
  const { wake, calls } = wakeHarness({
    recoverExistingRuntime: () => ({ action: 'launch', reason: 'absence-proven' }),
  })
  const result = await wake({ mint_id: 'mint-1' })
  assert.equal(result.ok, true)
  assert.equal(result.resumed, true)
  assert.equal(calls.resumed, 1)
}

// 25. A rebind whose write did not land. The recovery saw a live runtime, and
//     the mint is still bound to nothing -- so the wake must not report the
//     agent awake on the strength of that earlier observation. Liveness
//     observed before a failed write is not liveness of anything addressable.
{
  const { wake, calls } = wakeHarness({
    recoverExistingRuntime: (facts) => ({ action: 'rebound', session: 'fleet-half-minted', facts }),
  })
  await assert.rejects(
    () => wake({ mint_id: 'mint-1' }),
    /could not rebind mint mint-1: the recovery adopted fleet-half-minted but no process state was recorded/,
  )
  assert.equal(calls.resumed, 0, 'a failed rebind does not fall through to a spawn either')
}

// 26. The same, one step later: the write landed, and nothing is running under
//     the session it named -- the runtime died between the recovery's probe and
//     the write. The recovery's earlier observation does not stand in for a
//     confirmation taken after the write, so this is a failed wake and not an
//     awake agent.
{
  const { wake, calls } = wakeHarness({
    liveSessions: ['fleet-half-minted-2'],
    recoverExistingRuntime: (facts, store) => {
      store.updateProcessState(facts.mintId, { tmux_session: 'fleet-half-minted' })
      return { action: 'rebound', session: 'fleet-half-minted', facts: store.get(facts.mintId) }
    },
  })
  await assert.rejects(
    () => wake({ mint_id: 'mint-1' }),
    /wake rebound mint mint-1 to fleet-half-minted, but no live runtime was confirmed there/,
  )
  assert.equal(calls.resumed, 0, 'a rebind that could not be confirmed does not fall through to a spawn')
}

// ---------------------------------------------------------------------------
// 27. Production-shaped, end to end: the real decision module, the real mint
//     core doing the write, and the real wake core confirming it. The only
//     fakes are the box itself -- tmux, the runtime probe, and the ledger.
//
//     A row with process_state null, one live session carrying the mint's own
//     FLEET_ID: the wake must come back with that agent awake and addressable,
//     having spawned nothing, resumed nothing, requested no seat, and allocated
//     no session name.
{
  const calls = { launched: 0, seats: 0, resumed: 0, namesAllocated: 0, bound: 0 }
  const store = memoryStore({ 'mint-1': { ...PARTIAL_ROW, joinedAt: null } })

  const LIVE_SESSION = 'fleet-half-minted'
  const box = {
    sessions: [LIVE_SESSION, 'fleet-someone-else'],
    runtimes: { [LIVE_SESSION]: { probed: true, runtime: true, fleetId: 'fleet:a8196c6d', envName: 'testing', daemonKey: 'mini:testing' } },
    ledger: [{
      id: 'fleet:a8196c6d',
      friendlyName: 'half-minted',
      tmuxSession: LIVE_SESSION,
      sessionKind: 'codex',
      sessionId: 'session-live',
      sessionPath: '/rollouts/session-live.jsonl',
      model: 'opus',
      cwd: '/Users/skip/work/tlda',
      envName: 'testing',
      daemonKey: 'mini:testing',
    }],
  }

  const core = createDaemonMintCore({
    store,
    envName: 'testing',
    processAlive: async facts => !!box.runtimes[facts.processState?.tmux_session]?.runtime,
    launchProcess: async () => {
      calls.launched += 1
      calls.namesAllocated += 1
      throw new Error('the live runtime was spawned over')
    },
    requestSeat: async () => { calls.seats += 1; return { fleet_id: 'fleet:new' } },
    bindSeat: async () => { calls.bound += 1 },
  })

  const recoverExistingRuntime = async facts => {
    const decision = await resolvePartialMintRuntime({
      facts,
      expectedIdentity: f => ({
        fleetId: f.fleetId,
        mintId: f.mintId,
        sessionId: f.sessionId,
        friendlyName: f.friendlyName,
        cwd: f.launchRecipe?.cwd,
        harness: f.launchRecipe?.kind,
        model: f.launchRecipe?.model,
        envName: f.envName,
        daemonKey: 'mini:testing',
      }),
      candidateSessions: f => {
        const found = []
        const row = box.ledger.find(entry => entry.id === f.fleetId)
        if (row?.tmuxSession) found.push({ tmuxSession: row.tmuxSession, source: 'ledger-fleet-id', binding: row })
        found.push({ tmuxSession: `fleet-${f.friendlyName}`, source: 'launch-recipe-session' })
        return found
      },
      listSessions: async () => ({ probed: true, names: box.sessions }),
      probeSession: async session => box.runtimes[session] || { probed: true, runtime: false },
      observeRuntimeIdentity: async candidate => {
        const rows = box.ledger.filter(entry => entry.tmuxSession === candidate.tmuxSession)
        const binding = candidate.binding || rows[0] || null
        return {
          fleetId: candidate.probe?.fleetId || binding?.id || null,
          sessionId: binding?.sessionId || null,
          sessionPath: binding?.sessionPath || null,
          friendlyName: binding?.friendlyName || null,
          cwd: binding?.cwd || null,
          harness: binding?.sessionKind || null,
          model: binding?.model || null,
          envName: candidate.probe?.envName || binding?.envName || null,
          daemonKey: candidate.probe?.daemonKey || binding?.daemonKey || null,
          ledgerBindsSingleRuntime: rows.length === 1,
          strongFieldSources: {
            fleetId: candidate.probe?.fleetId ? 'runtime-argv' : (binding?.id ? 'ledger' : null),
            sessionId: binding?.sessionId ? 'ledger' : null,
          },
        }
      },
    })
    if (decision.action !== 'rebind') return decision
    const observed = decision.observed
    const rebound = await core.recordProcess(facts.mintId, {
      mint_id: facts.mintId,
      fleet_id: facts.fleetId,
      name: facts.friendlyName,
      tmux_session: decision.session,
      cwd: observed.cwd,
      harness: observed.harness,
      model: observed.model,
      session_id: observed.sessionId,
      session_path: observed.sessionPath,
    })
    return { action: 'rebound', reason: decision.reason, session: decision.session, facts: rebound }
  }

  const wake = createDaemonWakeCore({
    store,
    processAlive: async facts => !!box.runtimes[facts.processState?.tmux_session]?.runtime,
    resumeSession: async () => { calls.resumed += 1; return { tmux_session: 'fleet-half-minted-2' } },
    recoverExistingRuntime,
  })

  assert.equal(store.get('mint-1').processState, undefined, 'the row starts with no process state')

  const result = await wake({ mint_id: 'mint-1' })

  assert.equal(result.ok, true)
  assert.equal(result.rebound, true)
  assert.equal(result.alreadyAlive, true)
  assert.equal(result.processState.tmux_session, LIVE_SESSION, 'the session already up, not a rotated one')
  assert.equal(calls.launched, 0, 'nothing spawned')
  assert.equal(calls.resumed, 0, 'nothing resumed')
  assert.equal(calls.seats, 0, 'no seat requested')
  assert.equal(calls.namesAllocated, 0, 'no session name allocated')

  // Addressable, not merely running: the seat is bound and the mint is joined,
  // which is what a delivery needs and what the duplicate-spawn outcome never
  // produced for the agent that was actually alive.
  assert.equal(calls.bound, 1)
  const row = store.get('mint-1')
  assert.equal(row.joinedAt, '2026-09-08T11:00:00Z')
  assert.equal(row.sessionId, 'session-live')
  assert.equal(row.processState.tmux_session, LIVE_SESSION)
}

console.log('a partial mint does not spawn over a live runtime: ok')
