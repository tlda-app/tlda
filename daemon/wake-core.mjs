export function createDaemonWakeCore({
  store,
  processAlive,
  processDaemonKey = null,
  replaceProcess = null,
  targetDaemonKey = null,
  resumeSession,
}) {
  return async function wake(input) {
    const params = input && typeof input === 'object' ? input : { fleet_id: input }
    const identifier = params.mint_id || params.mintId || params.fleet_id || params.fleetId || params.name
    if (!identifier) throw new Error('wake requires a local mint, fleet, or friendly-name identifier')
    const facts = store.resolve(identifier)
    if (!facts) throw new Error(`no daemon mint facts for ${identifier}`)
    if (!facts.sessionId) throw new Error(`mint ${facts.mintId} is not resumable: no session_id`)
    const alive = await processAlive(facts)
    if (alive) {
      if (!params.takeover_existing) return { ok: true, alreadyAlive: true, ...facts }
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
    const resumed = await resumeSession(facts, params)
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
