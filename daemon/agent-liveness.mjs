// Daemon-side process-liveness state machine. One state per bound agent,
// decided here from process evidence. The server is told transitions and
// writes down what it is told; it decides nothing.
//
// States: hibernating (no process) -> waking (process sighted once,
// unconfirmed) -> awake (process confirmed, emitted). Death is symmetric:
// awake -> dying (process missed once, unconfirmed) -> hibernating
// (missed twice running, emitted). One disagreeing sweep is suspicion,
// not evidence — a transient empty tmux answer must not read as 34
// deaths. Unknown observations change nothing: unknown is a state of
// our knowledge, not of the agent.
//
// The wire carries only verdicts that change what the server shows. Waking
// is daemon-side only, and dead is emitted only when leaving awake: the
// server already reads everything else as hibernating, so re-emitting it
// would be thousands of no-op writes plus their side effects on every boot.
// A binding the daemon has never seen alive is silent until sighted.
//
// Process sightings arrive as evidence (see agent-evidence.mjs): the sweep
// admits one envelope per observed binding, and consumeProcess moves the
// machine. Today the probe is the only source setting process; the log
// names the source only when it is not the probe.
export const PROCESS = Object.freeze({
  ALIVE: 'alive',
  DEAD: 'dead',
  UNKNOWN: 'unknown',
})

export const BINDING_STATE = Object.freeze({
  AWAKE: 'awake',
  WAKING: 'waking',
  DYING: 'dying',
  HIBERNATING: 'hibernating',
})

export function createAgentLiveness({
  getBindings,
  checkProcesses,
  sendMsg,
  log,
  getAdmit,
  source = 'daemon-process-check',
} = {}) {
  if (typeof getBindings !== 'function') throw new Error('agent liveness requires getBindings')
  if (typeof checkProcesses !== 'function') throw new Error('agent liveness requires checkProcesses')
  if (typeof sendMsg !== 'function') throw new Error('agent liveness requires sendMsg')
  if (typeof getAdmit !== 'function') throw new Error('agent liveness requires getAdmit')
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
  // dying->hibernating. Bindings that left the ledger retire the same way:
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
      if (state !== BINDING_STATE.AWAKE && state !== BINDING_STATE.DYING) continue
      log?.info?.(`liveness transition: agent=${agentId} ${state}->hibernating (unbound)`)
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
    const admit = getAdmit()
    const atMs = Date.now()
    for (const binding of bindings) {
      const agentId = binding.id
      const observed = observedFor(agentId)
      if (observed !== PROCESS.ALIVE && observed !== PROCESS.DEAD) continue
      admit({
        agentId,
        source: 'process-probe',
        atMs,
        process: observed === PROCESS.ALIVE ? 'alive' : 'dead',
      })
    }
    return states.size
  }

  // Consume one process sighting admitted as evidence. The transition table
  // is unchanged from the sweep-driven form: suspicion in both directions,
  // emits only on verdict changes.
  function consumeProcess(agentId, process, meta = {}) {
    if (!agentId) return undefined
    if (process !== 'alive' && process !== 'dead') return undefined
    const via = meta?.source && meta.source !== 'process-probe' ? ` (via ${meta.source})` : ''
    const state = states.get(agentId) || BINDING_STATE.HIBERNATING
    if (process === 'dead') {
      if (state === BINDING_STATE.DYING) {
        states.set(agentId, BINDING_STATE.HIBERNATING)
        log?.info?.(`liveness transition: agent=${agentId} dying->hibernating${via}`)
        emit(agentId, false)
        return BINDING_STATE.HIBERNATING
      }
      if (state !== BINDING_STATE.AWAKE) {
        states.set(agentId, BINDING_STATE.HIBERNATING)
        return BINDING_STATE.HIBERNATING
      }
      states.set(agentId, BINDING_STATE.DYING)
      log?.info?.(`liveness transition: agent=${agentId} awake->dying${via}`)
      return BINDING_STATE.DYING
    }
    if (state === BINDING_STATE.AWAKE) return BINDING_STATE.AWAKE
    if (state === BINDING_STATE.DYING) {
      states.set(agentId, BINDING_STATE.AWAKE)
      log?.info?.(`liveness transition: agent=${agentId} dying->awake${via}`)
      return BINDING_STATE.AWAKE
    }
    if (state === BINDING_STATE.WAKING) {
      states.set(agentId, BINDING_STATE.AWAKE)
      log?.info?.(`liveness transition: agent=${agentId} waking->awake${via}`)
      emit(agentId, true)
      return BINDING_STATE.AWAKE
    }
    states.set(agentId, BINDING_STATE.WAKING)
    log?.info?.(`liveness transition: agent=${agentId} hibernating->waking${via}`)
    return BINDING_STATE.WAKING
  }

  // Re-declare current awake verdicts. Runs on (re)connect so missed
  // transitions repair themselves. Awake and dying: a dying binding has
  // not emitted since its awake verdict, so the server still shows it
  // awake, and the next sweep resolves the suspicion either way.
  function declareAll() {
    let declared = 0
    for (const [agentId, state] of states) {
      if (state !== BINDING_STATE.AWAKE && state !== BINDING_STATE.DYING) continue
      emit(agentId, true)
      declared += 1
    }
    return declared
  }

  function stateFor(agentId) {
    return states.get(agentId) || null
  }

  function verdictFor(agentId) {
    const state = states.get(agentId)
    return state === BINDING_STATE.AWAKE || state === BINDING_STATE.DYING
  }

  function drop(agentId) {
    states.delete(agentId)
  }

  return { checkAll, consumeProcess, declareAll, stateFor, verdictFor, drop }
}
