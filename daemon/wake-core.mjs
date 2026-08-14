// Waking an agent is daemon-owned because the daemon knows whether it started a
// process. User-visible notification is channel-owned; daemon-local notify_text
// support remains for explicit terminal RPC callers, not as the fleet notice
// path.
export function createDaemonWakeCore({
  store,
  processAlive,
  processDaemonKey = null,
  replaceProcess = null,
  targetDaemonKey = null,
  resumeSession,
  notifyAgent = null,
  retryPolicy = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  return async function wake(input) {
    const params = input && typeof input === 'object' ? input : { fleet_id: input }
    const identifier = params.mint_id || params.mintId || params.fleet_id || params.fleetId || params.name
    if (!identifier) throw new Error('wake requires a local mint, fleet, or friendly-name identifier')
    const facts = store.resolve(identifier)
    if (!facts) throw new Error(`no daemon mint facts for ${identifier}`)
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

    // `started` is what the notice is about: the agent was gone and is back. An
    // agent that never stopped gets the message and nothing else.
    const tell = async (started) => {
      if (!notifyAgent || !params.notify_text) return null
      const notifyDelayMs = Math.max(0, Number(params.notify_delay_ms) || 0)
      if (started && notifyDelayMs > 0) await sleep(notifyDelayMs)
      const text = started && params.return_notice
        ? `${params.return_notice}\n\n${params.notify_text}`
        : params.notify_text
      const readyTimeoutMs = Number(params.notify_ready_timeout_ms) > 0
        ? params.notify_ready_timeout_ms
        : undefined
      return notifyAgent({
        facts,
        agentId: facts.fleetId || params.fleet_id || params.fleetId || null,
        text,
        enterDelayMs: params.enter_delay_ms,
        readyTimeoutMs,
        clearBeforeText: !!readyTimeoutMs,
        started,
      })
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
        const notified = await tell(false)
        return { ok: true, alreadyAlive: true, ...facts, ...(notified?.ok ? { notified: true } : {}) }
      }
      if (!targetDaemonKey || !processDaemonKey || !replaceProcess) {
        throw new Error(`mint ${facts.mintId} takeover is not configured on this daemon`)
      }
      const liveDaemonKey = await processDaemonKey(facts)
      if (liveDaemonKey === targetDaemonKey) {
        const notified = await tell(false)
        return { ok: true, alreadyAlive: true, ...facts, ...(notified?.ok ? { notified: true } : {}) }
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
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      params.onLifecycleEvent?.('wake-attempt', {
        local_agent_id: facts.mintId,
        fleet_id: facts.fleetId || null,
        name: facts.friendlyName || null,
        attempt: attempt + 1,
      })
      try {
        const attemptResult = await resumeSession(facts, params)
        if (!resumed) resumed = attemptResult
        resumeError = null
      } catch (error) {
        resumeError = error
      }
      runtimeConfirmed = await processAlive(facts)
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
      const notified = await tell(false)
      return { ok: true, alreadyAlive: true, ...facts, ...(notified?.ok ? { notified: true } : {}) }
    }
    const current = store.updateProcessState(facts.mintId, resumed)
    const notified = await tell(true)
    return {
      ok: true,
      resumed: true,
      ...(alive ? { takenOver: true } : {}),
      ...current,
      ...resumed,
      ...(notified?.ok ? { notified: true } : {}),
    }
  }
}
