export function createDaemonWakeCore({ store, processAlive, resumeSession }) {
  return async function wake(fleetId) {
    if (!fleetId) throw new Error('wake requires fleet_id')
    const facts = store.getByFleetId(fleetId)
    if (!facts) throw new Error(`no daemon mint facts for ${fleetId}`)
    if (!facts.sessionId) throw new Error(`mint ${facts.mintId} is not resumable: no session_id`)
    if (await processAlive(facts)) return { ok: true, alreadyAlive: true, ...facts }
    const resumed = await resumeSession(facts)
    return { ok: true, resumed: true, ...facts, ...resumed }
  }
}
