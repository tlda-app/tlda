export async function recordAgentRouteEvent(fleetStore, msg = {}, {
  daemonKey = null,
} = {}) {
  if (!fleetStore) throw new Error('fleet store is required')
  const agentId = msg.agent_id || msg.agentId
  const routeDaemonKey = msg.daemon_key || daemonKey
  if (!agentId) throw new Error('agent-route event missing agent_id')
  if (!routeDaemonKey) throw new Error(`agent-route event missing daemon_key for ${agentId}`)
  return await fleetStore.setAgentDaemonRoute(agentId, routeDaemonKey)
}
