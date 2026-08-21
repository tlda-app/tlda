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
  const results = [...message.agents]
  for (const agent of rows.values()) {
    if (agent.route_daemon_key === daemonKey && !seen.has(agent.id)) {
      results.push({ agent_id: agent.id, status: 'hibernating', activity: 'unknown', tool: null })
    }
  }
  return { sequence: message.report_seq, results }
}

export async function applyDaemonAgentStatusBatch(chains, generationKey, applyBatch) {
  const previous = chains.get(generationKey) || Promise.resolve()
  const current = previous.catch(() => {}).then(applyBatch)
  chains.set(generationKey, current)
  try {
    return await current
  } finally {
    if (chains.get(generationKey) === current) chains.delete(generationKey)
  }
}
