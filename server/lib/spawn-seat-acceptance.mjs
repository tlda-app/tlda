export function readAcceptedCurrentSeat(fleetStore, agentId, candidate = {}) {
  if (!agentId || !candidate || candidate.agent_id !== agentId) return null
  const current = fleetStore?.getCurrentAgentSeat?.(agentId)
  if (!current) return null
  for (const field of ['agent_id', 'session_id', 'daemon_key', 'terminal_capability', 'activated_at']) {
    if (!candidate[field] || !current[field] || current[field] !== candidate[field]) return null
  }
  return current
}

export function observeSpawnProcessLogin(spawnLibrarian, agent) {
  spawnLibrarian.observeLogin(agent)
}

export function observeSpawnAcceptedSeat(spawnLibrarian, fleetStore, agentId, candidate) {
  const accepted = readAcceptedCurrentSeat(fleetStore, agentId, candidate)
  if (!accepted) return false
  spawnLibrarian.observeSeat(accepted)
  return true
}
