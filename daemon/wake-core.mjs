// Waking an agent is daemon-owned because the daemon knows whether it started a
// process. It is ALL this does.
//
// Notification is the channel's, end to end: server -> the agent's MCP -> the
// agent. This module used to carry a second route — `tell()` typing
// `params.notify_text` into the pane, on three branches where the process was
// already alive, which is not a wake in any sense. Skip, 14:06:23: "why are we
// pushing notifications to the demon ever? We don't. That's a rule."
//
// A wake now says nothing about messages. The agent comes up, calls `login()`,
// and the server hands over the mail — which is what makes it impossible for a
// notification to be lost in two places instead of one.
export function createDaemonWakeCore({
  store,
  processAlive,
  processDaemonKey = null,
  replaceProcess = null,
  targetDaemonKey = null,
  resumeSession,
  retryPolicy = null,
  recoverExistingRuntime = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  return async function wake(input) {
    const params = input && typeof input === 'object' ? input : { fleet_id: input }
    const identifier = params.mint_id || params.mintId || params.fleet_id || params.fleetId || params.name
    if (!identifier) throw new Error('wake requires a local mint, fleet, or friendly-name identifier')
    let facts = store.resolve(identifier)
    if (!facts) throw new Error(`no daemon mint facts for ${identifier}`)
    // `processAlive` reads `processState.tmux_session`, so on a row that has no
    // process state it answers false for a reason that has nothing to do with
    // whether a process is running. Ask the bounded sources first. A rebind
    // adopts the runtime that is already up -- that agent is awake, which is
    // what the wake was for -- and a hold refuses rather than relaunching over
    // it. Anything else falls through to the unchanged wake below.
    if (recoverExistingRuntime && !facts.joinedAt) {
      const recovery = await recoverExistingRuntime(facts)
      if (recovery?.action === 'hold') {
        throw new Error(`wake refused for mint ${facts.mintId}: ${recovery.reason} (${recovery.session || (recovery.sessions || []).join(', ') || 'no session named'})`)
      }
      // `rebound` and `enriched` differ in what the recovery had to find -- a
      // runtime, or the binding for the one already recorded -- and not at all
      // in what has to be true afterwards. Both are confirmed the same way,
      // against the facts the recovery produced.
      if (recovery?.action === 'rebound' || recovery?.action === 'enriched') {
        // Confirm against what the rebind actually wrote, never against the row
        // this call started from. The pre-recovery `facts` carry no process
        // state -- that absence is the whole reason the recovery ran -- so
        // asking `processAlive` about them answers a question about a stale
        // row, and answering it `false` was how the wake path reported failure
        // over a runtime it had just successfully adopted.
        //
        // The write is checked before the runtime, so a rebind that did not
        // land cannot ride out on the recovery's earlier observation. A live
        // probe taken before a failed write is not evidence that the mint is
        // now bound to anything.
        const rebound = recovery.facts || null
        const reboundSession = rebound?.processState?.tmux_session || null
        if (!reboundSession) {
          throw new Error(
            `wake could not rebind mint ${facts.mintId}: the recovery adopted ${recovery.session || 'a live runtime'} `
            + 'but no process state was recorded for it',
          )
        }
        if (!await processAlive(rebound)) {
          throw new Error(`wake rebound mint ${facts.mintId} to ${reboundSession}, but no live runtime was confirmed there`)
        }
        facts = rebound
        return { ok: true, alreadyAlive: true, rebound: true, ...(recovery.action === 'enriched' ? { enriched: true } : {}), ...facts }
      }
    }
    // A mint with facts but no session is not unresumable — it is the partially
    // minted agent: the daemon prepared it, the launch recipe is on disk, and no
    // harness ever logged in to produce a session id. Finishing that is what the
    // stored recipe is for, and it is the same call resume already makes, with
    // `resumeId` null instead of a session to attach to.
    //
    // Skip, 2026-08-12 00:12 EDT: "the idea is, like, mint would finish minting a
    // fucking agent that was, like, partially minted" — with "wake is idempotent,
    // that's the design" (08-09 23:24) already true of everything below this line.
    //
    // Without a recipe there is nothing to finish, and that is the real
    // unresumable case. Three mints hit the old throw on 08-12 alone.
    //
    // Relaunching cannot double-start: the daemon calls resumeSession with
    // `exactTmuxSession`, so the session name is derived from the mint rather
    // than made unique, and launchMintProcess refuses a session that already has
    // a live harness runtime. A concurrent finish fails closed at the launcher.
    if (!facts.sessionId && !facts.launchRecipe) {
      throw new Error(`mint ${facts.mintId} is not resumable: no session_id and no launch recipe`)
    }

    const retry = retryPolicy?.(facts) || {}
    const attempts = params.wait_until_complete ? Infinity : Math.max(1, Number(retry.attempts) || 1)
    const confirmAttempts = Math.max(1, Number(retry.confirmAttempts) || Number(retry.attempts) || 1)
    const delayForAttempt = attempt => params.wait_until_complete
      ? Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)))
      : Math.max(0, Number(retry.delayMs) || 0)
    const wait = async attempt => {
      const delayMs = delayForAttempt(attempt)
      if (delayMs > 0) await sleep(delayMs)
    }

    let alive = await processAlive(facts)
    if (alive && retry.confirmExisting) {
      for (let attempt = 1; attempt < confirmAttempts; attempt += 1) {
        await wait(attempt)
        alive = await processAlive(facts)
        if (!alive) break
      }
    }
    if (alive) {
      if (!params.takeover_existing) {
        // `processAlive` answers "is a harness runtime in that tmux session",
        // which is a question about a process, not about an agent. A mint whose
        // process is up but which never completed its join has no registry row,
        // so nobody can address it, delegate to it, or wake it — and this line
        // used to answer `ok: true, alreadyAlive: true` for exactly that.
        //
        // It was the third surface reporting health over one absence in a single
        // morning: the mint returned success, the delegate returned success, and
        // then the wake being used as a workaround for both returned success.
        // The roster alone said the true thing — "a resolvable name with no row
        // is a missing agent, not a missing name".
        //
        // `joinedAt` is a fact rather than a proxy: mint-core sets it only after
        // bindSeat succeeds and COALESCE keeps it, so a returning agent always
        // carries it and only a never-joined mint lacks it.
        //
        // Relaunching is not the remedy — the process is already up, so the
        // launcher would refuse it — and wake cannot make a harness log in. All
        // this can do is stop claiming it worked, which is the whole ask.
        //
        // Deliberately only this branch. The takeover paths below replace the
        // process and resume, so they have somewhere to go; I have no evidence
        // about a never-joined takeover and am not guessing at one here.
        if (!facts.joinedAt) {
          throw new Error(
            `mint ${facts.mintId} has a live process that never joined: no registry row for ${facts.fleetId || '(no fleet id)'}. `
            + 'It cannot be addressed until it logs in; wake cannot complete a join.',
          )
        }
        return { ok: true, alreadyAlive: true, ...facts }
      }
      if (!targetDaemonKey || !processDaemonKey || !replaceProcess) {
        throw new Error(`mint ${facts.mintId} takeover is not configured on this daemon`)
      }
      const liveDaemonKey = await processDaemonKey(facts)
      if (liveDaemonKey === targetDaemonKey) {
        return { ok: true, alreadyAlive: true, ...facts }
      }
      if (!liveDaemonKey) {
        throw new Error(`mint ${facts.mintId} takeover refused: live process has no daemon ownership`)
      }
      if (!await replaceProcess(facts)) {
        throw new Error(`mint ${facts.mintId} takeover failed to terminate ${liveDaemonKey}`)
      }
      if (await processAlive(facts)) {
        throw new Error(`mint ${facts.mintId} takeover left ${liveDaemonKey} alive`)
      }
    }
    let resumed = null
    let resumeError = null
    let runtimeConfirmed = false
    // The process facts as they stand now, replaced by each attempt's result.
    // A partial mint starts with none, and the confirmation below reads the
    // recorded session -- so confirming against `facts` asked about the row the
    // wake began with and reported "did not produce a live runtime" for a
    // resume that had just produced one. The store is only written after
    // confirmation, which is why the freshest facts have to be carried here.
    let latestProcess = facts.processState || null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      params.onLifecycleEvent?.('wake-attempt', {
        local_agent_id: facts.mintId,
        fleet_id: facts.fleetId || null,
        name: facts.friendlyName || null,
        attempt: attempt + 1,
      })
      try {
        const attemptResult = await resumeSession(facts, params)
        if (attemptResult?.tmux_session || attemptResult?.tmuxSession) latestProcess = attemptResult
        if (!resumed) resumed = attemptResult
        resumeError = null
      } catch (error) {
        resumeError = error
      }
      runtimeConfirmed = await processAlive(latestProcess === facts.processState ? facts : { ...facts, processState: latestProcess })
      if (runtimeConfirmed) break
      if (attempt + 1 < attempts) {
        params.onLifecycleEvent?.('wake-deferred', {
          local_agent_id: facts.mintId,
          fleet_id: facts.fleetId || null,
          name: facts.friendlyName || null,
          attempt: attempt + 1,
          reason: resumeError?.message || 'runtime not yet live',
          retry_in_ms: delayForAttempt(attempt + 1),
        })
        await wait(attempt + 1)
      }
    }
    if (!runtimeConfirmed) {
      const detail = resumeError?.message ? `: ${resumeError.message}` : ''
      throw new Error(`wake did not produce a live runtime for ${facts.mintId}${detail}`)
    }
    if (!resumed) {
      return { ok: true, alreadyAlive: true, ...facts }
    }
    const current = store.updateProcessState(facts.mintId, resumed)
    return {
      ok: true,
      resumed: true,
      ...(alive ? { takenOver: true } : {}),
      ...current,
      ...resumed,
    }
  }
}
