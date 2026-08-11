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
    if (!facts.sessionId) throw new Error(`mint ${facts.mintId} is not resumable: no session_id`)

    // `started` is what the notice is about: the agent was gone and is back. An
    // agent that never stopped gets the message and nothing else.
    const tell = async (started) => {
      if (!notifyAgent || !params.notify_text) return null
      const notifyDelayMs = Math.max(0, Number(params.notify_delay_ms) || 0)
      if (started && notifyDelayMs > 0) await sleep(notifyDelayMs)
      const text = started && params.return_notice
        ? `${params.return_notice}\n\n${params.notify_text}`
        : params.notify_text
      return notifyAgent({
        facts,
        agentId: facts.fleetId || params.fleet_id || params.fleetId || null,
        text,
        enterDelayMs: params.enter_delay_ms,
        readyTimeoutMs: started ? params.notify_ready_timeout_ms : undefined,
        clearBeforeText: started && Number(params.notify_ready_timeout_ms) > 0,
        started,
      })
    }

    const retry = retryPolicy?.(facts) || {}
    const attempts = Math.max(1, Number(retry.attempts) || 1)
    const delayMs = Math.max(0, Number(retry.delayMs) || 0)
    const wait = async () => {
      if (delayMs > 0) await sleep(delayMs)
    }

    let alive = await processAlive(facts)
    if (alive && retry.confirmExisting) {
      for (let attempt = 1; attempt < attempts; attempt += 1) {
        await wait()
        alive = await processAlive(facts)
        if (!alive) break
      }
    }
    if (alive) {
      if (!params.takeover_existing) {
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
      try {
        const attemptResult = await resumeSession(facts, params)
        if (!resumed) resumed = attemptResult
        resumeError = null
      } catch (error) {
        resumeError = error
      }
      runtimeConfirmed = await processAlive(facts)
      if (runtimeConfirmed) break
      if (attempt + 1 < attempts) await wait()
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
