export function validateDaemonAgentStatusBatch({ message, daemonKey, bootId, lastSequence = 0, agents = [] }) {
  if (!message?.daemon_key || message.daemon_boot_id == null) return null
  if (message.daemon_key !== daemonKey || message.daemon_boot_id !== bootId) return null
  if (message.snapshot_complete !== true || !Array.isArray(message.agents)) return null
  if (!Number.isSafeInteger(message.report_seq) || message.report_seq <= lastSequence) return null

  const rows = new Map((agents || []).map(agent => [agent.id, agent]))
  const seen = new Set()
  for (const result of message.agents) {
    const agentId = result?.agent_id
    if (!agentId || seen.has(agentId)) return null
    if (!['awake', 'hibernating'].includes(result.status)) return null
    if (typeof result.activity !== 'string' || !result.activity) return null
    const agent = rows.get(agentId)
    if (!agent || agent.route_daemon_key !== daemonKey) return null
    seen.add(agentId)
  }
  return { sequence: message.report_seq, results: message.agents }
}
