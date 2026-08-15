import { randomUUID } from 'node:crypto'

function resultFact(result, snake, camel = snake) {
  return result?.[snake] ?? result?.[camel] ?? null
}

function emitLifecycle(onLifecycleEvent, event, data = {}) {
  try {
    onLifecycleEvent?.(event, data)
  } catch {
    // Progress reporting is advisory; mint facts are the durable result.
  }
}

function persistentLaunchRecipe(launch = {}) {
  const { permissionSet: _permissionSet, permission_set: _permission_set, ...rest } = launch || {}
  return rest
}

export function createDaemonMintCore({
  store,
  launchProcess,
  processAlive = null,
  requestSeat,
  bindSeat,
  mintId = randomUUID,
  envName = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  retryDelay = attempt => Math.min(30_000, 500 * (2 ** Math.min(attempt - 1, 6))),
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
    const current = store.get(mintIdValue)
    if (current?.processState && store.updateProcessState) store.updateProcessState(mintIdValue, process)
    else store.setFact(mintIdValue, 'process_state', process)
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
    fail_if_not_fresh = false,
    onLifecycleEvent = null,
    on_lifecycle_event = null,
  } = {}) {
    const lifecycle = onLifecycleEvent || on_lifecycle_event
    const id = suppliedMintId || mintId()
    store.ensure(id)
    if (envName) store.setFact(id, 'env_name', envName)
    if (name) store.setFact(id, 'friendly_name', name)
    if (metadata) store.setFact(id, 'metadata', metadata)
    store.setFact(id, 'launch_recipe', persistentLaunchRecipe(launch))
    if (suppliedFleetId) store.setFact(id, 'fleet_id', suppliedFleetId)

    // CLI mint starts both actions before awaiting either. Server mint supplies
    // fleet_id and therefore uses this same core without starting a second seat request.
    const existing = store.get(id)
    const reuseExistingProcess = !!existing?.processState && (!processAlive || await processAlive(existing))
    const processPromise = reuseExistingProcess
      ? Promise.resolve(existing)
      : Promise.resolve().then(() => launchProcess({
        mint_id: id,
        fleet_id: suppliedFleetId,
        name,
        ...launch,
      }))
      .then(async process => {
        const facts = await recordProcess(id, process)
        emitLifecycle(lifecycle, 'local-launch', {
          local_agent_id: id,
          fleet_id: facts?.fleetId || suppliedFleetId || null,
          name: facts?.friendlyName || name || null,
          tmux_session: process?.tmux_session || process?.tmuxSession || facts?.processState?.tmux_session || null,
          cwd: process?.cwd || launch?.cwd || null,
          harness: process?.harness || launch?.kind || null,
          model: process?.model || launch?.model || null,
        })
        if (facts?.joinedAt) {
          emitLifecycle(lifecycle, 'server-binding-joined', {
            local_agent_id: id,
            fleet_id: facts.fleetId || suppliedFleetId || null,
            name: facts.friendlyName || name || null,
          })
        }
        return facts
      })
    const seatPromise = suppliedFleetId || existing?.fleetId || !request_seat
      ? Promise.resolve(null)
      : Promise.resolve().then(async () => {
          let attempt = 0
          for (;;) {
            attempt++
            emitLifecycle(lifecycle, 'server-registration-attempt', {
              local_agent_id: id,
              name,
              attempt,
            })
            try {
              const seat = await requestSeat({ mint_id: id, name, metadata, launch, fail_if_not_fresh })
              const facts = await recordSeat(id, seat)
              emitLifecycle(lifecycle, 'server-registration-joined', {
                local_agent_id: id,
                fleet_id: facts.fleetId || resultFact(seat, 'fleet_id', 'fleetId') || null,
                name: facts.friendlyName || name || null,
              })
              if (facts?.joinedAt) {
                emitLifecycle(lifecycle, 'server-binding-joined', {
                  local_agent_id: id,
                  fleet_id: facts.fleetId || resultFact(seat, 'fleet_id', 'fleetId') || null,
                  name: facts.friendlyName || name || null,
                })
              }
              return facts
            } catch (error) {
              if (fail_if_not_fresh) throw error
              const delayMs = retryDelay(attempt)
              emitLifecycle(lifecycle, 'server-registration-deferred', {
                local_agent_id: id,
                fleet_id: store.get(id)?.fleetId || null,
                name: store.get(id)?.friendlyName || name || null,
                tmux_session: store.get(id)?.processState?.tmux_session || null,
                reason: error?.message || String(error),
                attempt,
                retry_in_ms: delayMs,
              })
              await sleep(delayMs)
            }
          }
        })

    await Promise.all([processPromise, seatPromise])
    if (request_seat || suppliedFleetId || existing?.fleetId) {
      let attempt = 0
      for (;;) {
        const facts = await join(id)
        if (facts?.joinedAt) return facts
        attempt++
        const delayMs = retryDelay(attempt)
        emitLifecycle(lifecycle, 'server-binding-deferred', {
          local_agent_id: id,
          fleet_id: facts?.fleetId || suppliedFleetId || null,
          name: facts?.friendlyName || name || null,
          tmux_session: facts?.processState?.tmux_session || null,
          reason: !facts?.sessionId ? 'runtime identity pending' : 'route publication pending',
          attempt,
          retry_in_ms: delayMs,
        })
        await sleep(delayMs)
      }
    }
    return store.get(id)
  }

  return { mint, recordProcess, recordSession, recordSeat, join }
}
