export function createDaemonWakeCore({ store, processAlive, resumeSession }) {
  return async function wake(input) {
    const params = input && typeof input === 'object' ? input : { fleet_id: input }
    const identifier = params.mint_id || params.mintId || params.fleet_id || params.fleetId || params.name
    if (!identifier) throw new Error('wake requires a local mint, fleet, or friendly-name identifier')
    const facts = store.resolve(identifier)
    if (!facts) throw new Error(`no daemon mint facts for ${identifier}`)
    if (!facts.sessionId) throw new Error(`mint ${facts.mintId} is not resumable: no session_id`)
    if (await processAlive(facts)) return { ok: true, alreadyAlive: true, ...facts }
    const resumed = await resumeSession(facts, params)
    const current = store.updateProcessState(facts.mintId, resumed)
    return { ok: true, resumed: true, ...current, ...resumed }
  }
}
