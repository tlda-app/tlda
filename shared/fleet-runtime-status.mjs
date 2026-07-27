export function runtimeStatusForAgent(agent) {
  const runtime = agent?.runtime_status
  if (runtime && typeof runtime === 'object') return runtime
  return {
    status: agent?.dead ? 'dead' : agent?.human ? 'human' : 'hibernating',
    route_state: agent?.route_state || null,
    route_reason: agent?.route_reason || null,
    activity: agent?.activity || 'unknown',
    reason: agent?.status_reason || null,
  }
}

export function isFleetRosterAgent(agent) {
  return !!agent && !agent.dead && !agent.metadata?.shell
}

export function runtimeStatusName(agent) {
  return runtimeStatusForAgent(agent).status
}

export function isRuntimeAwake(agent) {
  return runtimeStatusName(agent) === 'awake'
}

export function fleetRosterCategory(agent) {
  if (agent?.dead) return 'dead'
  const status = runtimeStatusName(agent)
  if (status === 'human') return 'awake'
  if (status === 'human-away') return 'hibernating'
  return status === 'awake' ? 'awake' : 'hibernating'
}

export function isRuntimeHibernating(agent) {
  const status = runtimeStatusName(agent)
  return status === 'hibernating' || status === 'human-away'
}

export function isTerminalRoutable(agent) {
  const runtime = runtimeStatusForAgent(agent)
  return runtime.route_state == null || runtime.route_state === 'routable'
}
