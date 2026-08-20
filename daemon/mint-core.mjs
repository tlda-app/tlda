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

// What a wake needs that has no other source: the harness, the model, the cwd,
// the grant. Not the bot fields — `bots.yaml` declares those, and a copy taken
// here at mint time is a second answer to a question the declaration already
// answers, free to drift from it the moment anyone edits the file.
//
// Skip, 2026-08-19: "there shouldn't be a fucking bot recipe. Bots use fucking
// mint and wake like everybody else. The whole recipe garbage is just a recipe
// for fucking disaster."
//
// The bot recipe and the wake recipe were different things sharing one field,
// which is why this reads as deleting a whole concept and is in fact deleting
// six keys. The wake recipe stays; every agent is woken from it.
const DECLARED_BY_BOTS_YAML = [
  'botScript', 'bot_script', 'script',
  'botName', 'bot_name',
  'botPidFile', 'bot_pid_file',
  'botHeartbeatFile', 'bot_heartbeat_file',
  'botWaitChannel', 'bot_wait_channel',
  'botEnv', 'bot_env',
]

function persistentLaunchRecipe(launch = {}) {
  const { permissionSet: _permissionSet, permission_set: _permission_set, ...rest } = launch || {}
  for (const key of DECLARED_BY_BOTS_YAML) delete rest[key]
  return rest
}

// The identity a named mint already recorded, or null. A mint id that resolves to
// a fleet id is one agent starting again rather than a new one, which is the whole
// difference between a supervised bot and a fresh spawn: nothing may ask the
// allocator for that agent's name a second time. mint() applies this itself before
// requesting a seat; a caller that reserves a seat of its own ahead of mint() has
// to apply it too, or it re-creates the agent mint() would have reused.
export function recordedMintIdentity(store, mintId) {
  if (!store || !mintId) return null
  const facts = store.get?.(mintId) || null
  return facts?.fleetId ? facts : null
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
  // How long a mint may go on trying to register and bind before it reports
  // failure. Both retry loops below were `for (;;)` with no cap, no deadline and
  // no give-up, so a mint that could not finish never stopped and never told
  // anyone. The daemon injects this from daemon.yaml; the default here is only
  // for callers that construct a core without one.
  registrationDeadlineMs = 5 * 60_000,
  monotonicNow = () => Date.now(),
}) {
  if (!store || !launchProcess || !bindSeat) throw new Error('mint core dependencies are required')
  const joins = new Map()

  async function join(mintIdValue) {
    const facts = store.get(mintIdValue)
    if (!facts?.fleetId || !facts?.processState || facts.joinedAt) return facts
    if (joins.has(mintIdValue)) return joins.get(mintIdValue)
    const joining = Promise.resolve()
      .then(async () => {
        const current = store.get(mintIdValue)
        if (!current?.fleetId || !current?.processState || current.joinedAt) return current
        await bindSeat(current)
        // The durable permission grant belongs to the launched seat, not to the
        // later transcript discovery. bindSeat records that grant immediately;
        // only the completed runtime identity marks the mint joined.
        if (!current.sessionId) return store.get(mintIdValue)
        return store.markJoined(mintIdValue)
      })
      .finally(() => joins.delete(mintIdValue))
    joins.set(mintIdValue, joining)
    return joining
  }

  async function recordSession(mintIdValue, session) {
    const sessionId = resultFact(session, 'session_id', 'sessionId')
    const sessionPath = resultFact(session, 'session_path', 'sessionPath')
    if (sessionId || sessionPath) {
      // A supervised bot reuses its mint id across restarts, so the session
      // recorded here is routinely a different one from the session already
      // stored. setFact treats that as a fact conflict and throws, which stops
      // the restart -- the same failure `friendly_name` had, one field over.
      if (store.updateSessionFacts) store.updateSessionFacts(mintIdValue, { sessionId, sessionPath })
      else {
        if (sessionId) store.setFact(mintIdValue, 'session_id', sessionId)
        if (sessionPath) store.setFact(mintIdValue, 'session_path', sessionPath)
      }
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
    // updateFriendlyName rather than setFact, because the name recorded here is
    // frequently NOT the name that was requested. A collision assigns an
    // alternate, and setFact treats an assigned name as conflicting with the
    // requested one and throws -- so the seat could not be recorded at all, and
    // the seat loop retried an unrecordable seat forever. That is the launcher
    // half of the collision loop; a mint that collides is supposed to take the
    // alternate name and let its bot go inert, which is the design.
    if (friendlyName) {
      if (store.updateFriendlyName) store.updateFriendlyName(mintIdValue, friendlyName)
      else store.setFact(mintIdValue, 'friendly_name', friendlyName)
    }
    // No join here. Recording a seat and binding it are two operations with two
    // failure modes, and this call sits inside the seat-request retry: a bind
    // failure -- whose first act is permissionLedger.set, an async write on a
    // worker thread that reports a timeout of its own -- was caught by the
    // seat-request handler, which then asked the server for another seat. One
    // transient ledger write turned into a shell-minting loop at the backoff
    // cap, one orphan row per attempt, forever.
    //
    // The ledger write is local. Nothing about the failure is the server's, and
    // that is exactly why answering it with another seat request was wrong.
    //
    // Nothing is lost by dropping it. mint()'s binding loop calls join()
    // immediately after the seat resolves, with no sleep before its first
    // attempt, and it is where a bind failure is already retried and reported as
    // `server-binding-deferred`. recordMintMarker's other caller joins through
    // recordSession on the next line.
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
    // The recipe of THIS launch, not of the first one. A supervised bot reuses its
    // mint id across restarts by design, and its recipe legitimately differs
    // between them -- a resolved model alias, a changed daemon config, a field a
    // newer build adds. setFact calls any difference a conflict and throws, so
    // `mint bot:testing:todd already has a different launch_recipe` stopped every
    // supervised bot from restarting at all.
    //
    // Reachable only since mint-id reuse became structural: before that a bot got
    // a fresh mint row per start, so this always wrote to an empty column. The
    // reuse is what this file wanted; the conflict check is what it outgrew.
    // wake-core and wake-permission-profile read this back to relaunch, and they
    // need the current recipe rather than the first one ever recorded.
    if (store.updateLaunchRecipe) store.updateLaunchRecipe(id, persistentLaunchRecipe(launch))
    else store.setFact(id, 'launch_recipe', persistentLaunchRecipe(launch))
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
        // recordProcess joins through recordSession as soon as both facts exist.
        // That eager attempt is worth making, but the process is already running
        // by now, so a failed binding must not fail the launch and strand a tmux
        // session -- the binding loop below owns that outcome and reports it.
        const facts = await recordProcess(id, process).catch(error => {
          emitLifecycle(lifecycle, 'server-binding-error', {
            local_agent_id: id,
            fleet_id: store.get(id)?.fleetId || suppliedFleetId || null,
            name: store.get(id)?.friendlyName || name || null,
            reason: error?.message || String(error),
            attempt: 0,
          })
          return store.get(id)
        })
        emitLifecycle(lifecycle, 'local-launch', {
          local_agent_id: id,
          fleet_id: facts?.fleetId || suppliedFleetId || null,
          name: facts?.friendlyName || name || null,
          tmux_session: process?.tmux_session || process?.tmuxSession || facts?.processState?.tmux_session || null,
          cwd: process?.cwd || launch?.cwd || null,
          harness: process?.harness || launch?.kind || null,
          model: process?.model || launch?.model || null,
        })
        // `server-binding-joined` is emitted once, by the binding loop. It used
        // to be emitted from whichever of these two branches first observed
        // `joinedAt`, which is why it appears twice in the same shape below.
        return facts
      })
    const registrationStartedAt = monotonicNow()
    const registrationExpired = () => monotonicNow() - registrationStartedAt >= registrationDeadlineMs
    let registrationError = null
    const seatPromise = suppliedFleetId || existing?.fleetId || !request_seat
      ? Promise.resolve(null)
      : Promise.resolve().then(async () => {
          let attempt = 0
          for (;;) {
            // A mint that already holds a seat must never ask for another one.
            // The server has no memory of a mint id -- `local_agent_id` is echoed
            // back and nothing else -- so every seat request without a fleet id
            // mints a fresh shell row. Re-requesting after the identity is
            // recorded is what turned a retry into an orphan generator, and the
            // store would reject the second fleet id as a fact conflict anyway,
            // so the retry could never even adopt the row it had just created.
            const held = store.get(id)
            if (held?.fleetId) return held
            if (registrationExpired()) {
              registrationError = `mint ${id} gave up requesting a fleet seat after ${attempt} attempts in ${Math.round((monotonicNow() - registrationStartedAt) / 1000)}s`
              emitLifecycle(lifecycle, 'server-registration-abandoned', {
                local_agent_id: id,
                name: store.get(id)?.friendlyName || name || null,
                tmux_session: store.get(id)?.processState?.tmux_session || null,
                reason: registrationError,
                attempts: attempt,
              })
              return null
            }
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
    // No seat, so there is nothing to bind. Say so once rather than spinning a
    // binding loop against an identity that was never issued.
    if (registrationError) return { ...store.get(id), registrationError }
    if (request_seat || suppliedFleetId || existing?.fleetId) {
      let attempt = 0
      for (;;) {
        let facts
        try {
          facts = await join(id)
        } catch (error) {
          // A bind failure is a bind failure. It used to reject out of
          // recordSeat into the seat-request handler, which answered a failed
          // permission-ledger write by minting another shell.
          facts = store.get(id)
          emitLifecycle(lifecycle, 'server-binding-error', {
            local_agent_id: id,
            fleet_id: facts?.fleetId || suppliedFleetId || null,
            name: facts?.friendlyName || name || null,
            reason: error?.message || String(error),
            attempt: attempt + 1,
          })
        }
        if (facts?.joinedAt) {
          // This loop is now the only place a mint binds, so it is the only place
          // that can say a mint bound. recordSeat used to join eagerly and the
          // event was emitted from whichever branch happened to observe
          // `joinedAt` first; with the eager join gone, neither branch sees it.
          emitLifecycle(lifecycle, 'server-binding-joined', {
            local_agent_id: id,
            fleet_id: facts.fleetId || suppliedFleetId || null,
            name: facts.friendlyName || name || null,
          })
          return facts
        }
        // A fresh Codex runtime has no resume/session id until its rollout is
        // opened and observed. The process, seat, and grant are already
        // durable at this point; session discovery calls recordSession() and
        // completes the join asynchronously. Do not hold the mint RPC open (or
        // turn a healthy logged-in process into a launch failure) while waiting
        // for that later identity fact.
        if (facts?.fleetId && facts?.processState && !facts?.sessionId) {
          emitLifecycle(lifecycle, 'server-binding-deferred', {
            local_agent_id: id,
            fleet_id: facts.fleetId,
            name: facts.friendlyName || name || null,
            tmux_session: facts.processState?.tmux_session || null,
            reason: 'runtime identity pending',
            attempt,
            retry_in_ms: null,
          })
          return facts
        }
        if (registrationExpired()) {
          emitLifecycle(lifecycle, 'server-binding-abandoned', {
            local_agent_id: id,
            fleet_id: facts?.fleetId || suppliedFleetId || null,
            name: facts?.friendlyName || name || null,
            tmux_session: facts?.processState?.tmux_session || null,
            reason: !facts?.sessionId ? 'runtime identity pending' : 'route publication pending',
            attempts: attempt,
          })
          return store.get(id)
        }
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
