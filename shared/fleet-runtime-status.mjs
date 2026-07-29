export const RUNTIME_KIND = Object.freeze({
  HUMAN: 'human',
  AI: 'ai',
})

export const RUNTIME_STATUS = Object.freeze({
  HERE: 'here',
  AWAY: 'away',
  AWAKE: 'awake',
  HIBERNATING: 'hibernating',
  DEAD: 'dead',
})

const VALID_STATUS_BY_KIND = Object.freeze({
  [RUNTIME_KIND.HUMAN]: new Set([RUNTIME_STATUS.HERE, RUNTIME_STATUS.AWAY]),
  [RUNTIME_KIND.AI]: new Set([RUNTIME_STATUS.AWAKE, RUNTIME_STATUS.HIBERNATING, RUNTIME_STATUS.DEAD]),
})

export function assertRuntimeState(state, context = 'runtime state') {
  const kind = state?.kind
  const status = state?.status
  if (!VALID_STATUS_BY_KIND[kind]?.has(status)) {
    throw new TypeError(
      `${context} must be human→here|away or ai→awake|hibernating|dead; received ${String(kind)}→${String(status)}`,
    )
  }
  return state
}

export function runtimeState(kind, status, detail = {}) {
  return assertRuntimeState({ ...detail, kind, status })
}

export function runtimeStatusForAgent(agent) {
  const runtime = agent?.runtime_status
  if (runtime && typeof runtime === 'object') {
    return assertRuntimeState(runtime, `runtime_status for ${agent?.id || 'agent'}`)
  }

  const kind = agent?.human ? RUNTIME_KIND.HUMAN : RUNTIME_KIND.AI
  const status = kind === RUNTIME_KIND.HUMAN
    ? RUNTIME_STATUS.AWAY
    : agent?.dead ? RUNTIME_STATUS.DEAD : RUNTIME_STATUS.HIBERNATING
  return runtimeState(kind, status, {
    activity: agent?.activity || 'unknown',
    reason: agent?.status_reason || null,
  })
}

export function isFleetRosterAgent(agent) {
  return !!agent && !agent.dead && !agent.metadata?.shell
}

export function runtimeStatusName(agent) {
  return runtimeStatusForAgent(agent).status
}

export function isRuntimeAwake(agent) {
  const runtime = runtimeStatusForAgent(agent)
  return runtime.kind === RUNTIME_KIND.AI && runtime.status === RUNTIME_STATUS.AWAKE
}

export function fleetRosterCategory(agent) {
  const runtime = runtimeStatusForAgent(agent)
  if (runtime.kind === RUNTIME_KIND.HUMAN) {
    return runtime.status === RUNTIME_STATUS.HERE ? 'awake' : 'hibernating'
  }
  if (runtime.status === RUNTIME_STATUS.DEAD) return 'dead'
  return runtime.status === RUNTIME_STATUS.AWAKE ? 'awake' : 'hibernating'
}

export function isRuntimeHibernating(agent) {
  const runtime = runtimeStatusForAgent(agent)
  return runtime.kind === RUNTIME_KIND.AI
    ? runtime.status === RUNTIME_STATUS.HIBERNATING
    : runtime.status === RUNTIME_STATUS.AWAY
}
