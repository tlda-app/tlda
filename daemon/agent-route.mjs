export function createAgentRouteResolver({
  permissionLedger,
  daemonKey,
} = {}) {
  if (!permissionLedger?.get) {
    throw new Error('agent route resolver requires daemon permission ledger')
  }
  const ownerKey = String(daemonKey || '').trim()
  if (!ownerKey) {
    throw new Error('agent route resolver requires daemon key')
  }

  return function resolveAgentRoute({ agent_id: agentId } = {}) {
    const fleetId = String(agentId || '').trim()
    if (!fleetId) throw new Error('agent_id required')

    const row = permissionLedger.get(fleetId)
    if (!row) throw new Error(`agent route unavailable for ${fleetId}`)
    if (row.daemonKey !== ownerKey) {
      throw new Error(`agent ${fleetId} is not owned by daemon ${ownerKey}`)
    }
    if (!row.sessionId || !row.tmuxSession) {
      throw new Error(`agent route unavailable for ${fleetId}`)
    }

    return {
      agent_id: fleetId,
      session_id: row.sessionId,
      tmux_session: row.tmuxSession,
    }
  }
}
