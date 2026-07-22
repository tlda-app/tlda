export function readAcceptedCurrentSeat(fleetStore, agentId, candidate = {}) {
  if (!agentId || !candidate || candidate.agent_id !== agentId) return null
  const current = fleetStore?.getCurrentAgentSeat?.(agentId)
  if (!current) return null
  if (!current.session_id || current.session_id !== candidate.session_id) return null
  if (!current.terminal_capability || current.terminal_capability !== candidate.terminal_capability) return null
  return current
}
