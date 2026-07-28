export async function bindAgentRoute({ agentId, daemonKey, submit } = {}) {
  if (!agentId) throw new Error('agent route binding requires agentId')
  if (!daemonKey) throw new Error(`agent route binding requires daemonKey for ${agentId}`)
  if (typeof submit !== 'function') throw new Error('agent route binding requires submit')
  await submit({ agent_id: agentId, daemon_key: daemonKey })
  return { bound: true, agentId, daemonKey }
}
