// Daemon-side process-liveness state machine. One state per bound agent,
// decided here from process evidence. The server is told transitions and
// writes down what it is told; it decides nothing.
//
// States: hibernating (no process) -> waking (process sighted once,
// unconfirmed) -> awake (process confirmed, emitted). A confirmed dead
// process transitions straight into hibernation with no debounce — death is
// already confirmed by the check. Unknown observations change nothing:
// unknown is a state of our knowledge, not of the agent.
//
// The wire carries only verdicts that change what the server shows. Waking
// is daemon-side only, and dead is emitted only when leaving awake: the
// server already reads everything else as hibernating, so re-emitting it
// would be thousands of no-op writes plus their side effects on every boot.
// A binding the daemon has never seen alive is silent until sighted.
export const PROCESS = Object.freeze({
  ALIVE: 'alive',
  DEAD: 'dead',
  UNKNOWN: 'unknown',
})

export const BINDING_STATE = Object.freeze({
  AWAKE: 'awake',
  WAKING: 'waking',
  HIBERNATING: 'hibernating',
})

export function createAgentLiveness({
  getBindings,
  checkProcesses,
  sendMsg,
  log,
  source = 'daemon-process-check',
} = {}) {
  if (typeof getBindings !== 'function') throw new Error('agent liveness requires getBindings')
  if (typeof checkProcesses !== 'function') throw new Error('agent liveness requires checkProcesses')
  if (typeof sendMsg !== 'function') throw new Error('agent liveness requires sendMsg')
  const states = new Map()

  function emit(agentId, alive) {
    sendMsg({
      type: 'process-liveness',
      agent_id: agentId,
      alive,
      source,
      ts: new Date().toISOString(),
    })
  }

  // Check every binding once, in one batched probe. Emits only on transitions
  // that change the server-visible verdict: waking->awake and
  // awake->hibernating. Bindings that left the ledger retire the same way:
  // an unbound agent the daemon saw awake reads dead, because unbinding is
  // how the daemon records that it manages no process for it.
  async function checkAll() {
    let bindings
    try {
      bindings = (getBindings() || []).filter(binding => binding?.id)
    } catch (error) {
      log?.warn?.(`liveness bindings unreadable: ${error?.message || error}`)
      return states.size
    }
    const present = new Set(bindings.map(binding => binding.id))
    for (const [agentId, state] of states) {
      if (present.has(agentId)) continue
      states.delete(agentId)
      if (state !== BINDING_STATE.AWAKE) continue
      log?.info?.(`liveness transition: agent=${agentId} awake->hibernating (unbound)`)
      emit(agentId, false)
    }
    if (!bindings.length) return states.size
    let observedById
    try {
      observedById = await checkProcesses(bindings)
    } catch (error) {
      log?.warn?.(`liveness sweep failed: ${error?.message || error}`)
      return states.size
    }
    const observedFor = id => observedById instanceof Map ? observedById.get(id) : observedById?.[id]
    for (const binding of bindings) {
      const agentId = binding.id
      const observed = observedFor(agentId)
      if (observed !== PROCESS.ALIVE && observed !== PROCESS.DEAD) continue
      const state = states.get(agentId) || BINDING_STATE.HIBERNATING
      if (observed === PROCESS.DEAD) {
        if (state !== BINDING_STATE.AWAKE) {
          states.set(agentId, BINDING_STATE.HIBERNATING)
          continue
        }
        states.set(agentId, BINDING_STATE.HIBERNATING)
        log?.info?.(`liveness transition: agent=${agentId} awake->hibernating`)
        emit(agentId, false)
        continue
      }
      if (state === BINDING_STATE.AWAKE) continue
      if (state === BINDING_STATE.WAKING) {
        states.set(agentId, BINDING_STATE.AWAKE)
        log?.info?.(`liveness transition: agent=${agentId} waking->awake`)
        emit(agentId, true)
        continue
      }
      states.set(agentId, BINDING_STATE.WAKING)
      log?.info?.(`liveness transition: agent=${agentId} hibernating->waking`)
    }
    return states.size
  }

  // Re-declare current awake verdicts. Runs on (re)connect so missed
  // transitions repair themselves. Awake only: the server already reads
  // everything else as hibernating.
  function declareAll() {
    let declared = 0
    for (const [agentId, state] of states) {
      if (state !== BINDING_STATE.AWAKE) continue
      emit(agentId, true)
      declared += 1
    }
    return declared
  }

  function stateFor(agentId) {
    return states.get(agentId) || null
  }

  function verdictFor(agentId) {
    return states.get(agentId) === BINDING_STATE.AWAKE
  }

  function drop(agentId) {
    states.delete(agentId)
  }

  return { checkAll, declareAll, stateFor, verdictFor, drop }
}
