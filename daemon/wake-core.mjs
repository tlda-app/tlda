// Waking an agent and telling it something are one call.
//
// The server used to ask "did you start a process?", get an answer back, and
// then decide whether to prepend the return notice on a second call. That put a
// question across the boundary, and the answer was read under the wrong name for
// a month — every message to a paused agent arrived with "You were away as
// hibernating" on the front. Skip's ruling, 8/1: *"the server says to the demon,
// wake this guy. Did you wake them? If so, inject this in their fucking
// terminal."* So the caller sends both texts and the daemon, which is the only
// party that knows whether it started anything, chooses.
export function createDaemonWakeCore({
  store,
  processAlive,
  processDaemonKey = null,
  replaceProcess = null,
  targetDaemonKey = null,
  resumeSession,
  notifyAgent = null,
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
      const text = started && params.return_notice
        ? `${params.return_notice}\n\n${params.notify_text}`
        : params.notify_text
      return notifyAgent({
        facts,
        agentId: facts.fleetId || params.fleet_id || params.fleetId || null,
        text,
        enterDelayMs: params.enter_delay_ms,
        started,
      })
    }

    const alive = await processAlive(facts)
    if (alive) {
      if (!params.takeover_existing) {
        const notified = await tell(false)
        return { ok: true, alreadyAlive: true, ...facts, ...(notified ? { notified: true } : {}) }
      }
      if (!targetDaemonKey || !processDaemonKey || !replaceProcess) {
        throw new Error(`mint ${facts.mintId} takeover is not configured on this daemon`)
      }
      const liveDaemonKey = await processDaemonKey(facts)
      if (liveDaemonKey === targetDaemonKey) {
        const notified = await tell(false)
        return { ok: true, alreadyAlive: true, ...facts, ...(notified ? { notified: true } : {}) }
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
    const resumed = await resumeSession(facts, params)
    const current = store.updateProcessState(facts.mintId, resumed)
    const notified = await tell(true)
    return {
      ok: true,
      resumed: true,
      ...(alive ? { takenOver: true } : {}),
      ...current,
      ...resumed,
      ...(notified ? { notified: true } : {}),
    }
  }
}
