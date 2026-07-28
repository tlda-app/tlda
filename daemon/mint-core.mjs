import { randomUUID } from 'node:crypto'

function resultFact(result, snake, camel = snake) {
  return result?.[snake] ?? result?.[camel] ?? null
}

function persistentLaunchRecipe(launch = {}) {
  const { permissionSet: _permissionSet, permission_set: _permission_set, ...rest } = launch || {}
  return rest
}

export function createDaemonMintCore({
  store,
  launchProcess,
  requestSeat,
  bindSeat,
  mintId = randomUUID,
}) {
  if (!store || !launchProcess || !bindSeat) throw new Error('mint core dependencies are required')
  const joins = new Map()

  async function join(mintIdValue) {
    const facts = store.get(mintIdValue)
    if (!facts?.fleetId || !facts?.sessionId || !facts?.processState || facts.joinedAt) return facts
    if (joins.has(mintIdValue)) return joins.get(mintIdValue)
    const joining = Promise.resolve()
      .then(async () => {
        const current = store.get(mintIdValue)
        if (!current?.fleetId || !current?.sessionId || !current?.processState || current.joinedAt) return current
        await bindSeat(current)
        return store.markJoined(mintIdValue)
      })
      .finally(() => joins.delete(mintIdValue))
    joins.set(mintIdValue, joining)
    return joining
  }

  async function recordSession(mintIdValue, session) {
    if (resultFact(session, 'session_id', 'sessionId')) {
      store.setFact(mintIdValue, 'session_id', resultFact(session, 'session_id', 'sessionId'))
    }
    if (resultFact(session, 'session_path', 'sessionPath')) {
      store.setFact(mintIdValue, 'session_path', resultFact(session, 'session_path', 'sessionPath'))
    }
    await join(mintIdValue)
    return store.get(mintIdValue)
  }

  async function recordProcess(mintIdValue, process) {
    store.setFact(mintIdValue, 'process_state', process)
    return recordSession(mintIdValue, process)
  }

  async function recordSeat(mintIdValue, seat) {
    const fleetId = resultFact(seat, 'fleet_id', 'fleetId')
      || resultFact(seat, 'server_agent_id', 'serverAgentId')
      || seat?.agent?.id
    if (!fleetId) throw new Error('server seat request returned no fleet_id')
    store.setFact(mintIdValue, 'fleet_id', fleetId)
    const friendlyName = resultFact(seat, 'friendly_name', 'friendlyName')
      || resultFact(seat, 'assigned_name', 'assignedName')
      || seat?.agent?.friendly_name
    if (friendlyName) store.setFact(mintIdValue, 'friendly_name', friendlyName)
    await join(mintIdValue)
    return store.get(mintIdValue)
  }

  async function mint({
    mint_id: suppliedMintId = null,
    fleet_id: suppliedFleetId = null,
    name = null,
    metadata = null,
    launch = {},
    request_seat = true,
  } = {}) {
    const id = suppliedMintId || mintId()
    store.ensure(id)
    if (name) store.setFact(id, 'friendly_name', name)
    if (metadata) store.setFact(id, 'metadata', metadata)
    store.setFact(id, 'launch_recipe', persistentLaunchRecipe(launch))
    if (suppliedFleetId) store.setFact(id, 'fleet_id', suppliedFleetId)

    // CLI mint starts both actions before awaiting either. Server mint supplies
    // fleet_id and therefore uses this same core without starting a second seat request.
    const processPromise = Promise.resolve()
      .then(() => launchProcess({
        mint_id: id,
        fleet_id: suppliedFleetId,
        name,
        ...launch,
      }))
      .then(process => recordProcess(id, process))
    const seatPromise = suppliedFleetId || !request_seat
      ? Promise.resolve(null)
      : Promise.resolve()
          .then(() => requestSeat({ mint_id: id, name, metadata, launch }))
          .then(seat => recordSeat(id, seat))
          .catch(error => ({ error: error?.message || String(error) }))

    const [, seat] = await Promise.all([processPromise, seatPromise])
    const facts = store.get(id)
    return seat?.error ? { ...facts, registrationError: seat.error } : facts
  }

  return { mint, recordProcess, recordSession, recordSeat, join }
}
