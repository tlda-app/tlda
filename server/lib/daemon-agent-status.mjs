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

export function planDaemonAgentStatusBatch({ message, daemonKey, bootId, lastSequence = 0, routedAgents = [], knownAgents = [] }) {
  if (!message?.daemon_key || message.daemon_boot_id == null) return null
  if (message.daemon_key !== daemonKey || message.daemon_boot_id !== bootId) return null
  if (message.snapshot_complete !== true || !Array.isArray(message.agents)) return null
  if (!Number.isSafeInteger(message.report_seq) || message.report_seq <= lastSequence) return null

  const knownById = new Map(knownAgents.map(agent => [agent.id, agent]))
  const admissions = []
  const seen = new Set()
  for (const result of message.agents) {
    const id = result?.agent_id
    const identity = result?.identity
    if (!id || seen.has(id)) return null
    if (!['awake', 'hibernating'].includes(result.status)) return null
    if (typeof result.activity !== 'string' || !result.activity) return null
    if (!identity || typeof identity.friendly_name !== 'string' || !identity.friendly_name
      || typeof identity.runtime_kind !== 'string' || !identity.runtime_kind) return null
    const known = knownById.get(id)
    if (known?.route_daemon_key && known.route_daemon_key !== daemonKey) return null
    admissions.push({
      id,
      create: !known,
      friendly_name: identity.friendly_name,
      runtime_kind: identity.runtime_kind,
    })
    seen.add(id)
  }

  const admittedRows = admissions.map(admission => ({ id: admission.id, route_daemon_key: daemonKey }))
  const accepted = validateDaemonAgentStatusBatch({
    message,
    daemonKey,
    bootId,
    lastSequence,
    agents: [...routedAgents, ...admittedRows],
  })
  return accepted ? { ...accepted, admissions } : null
}

export async function applyDaemonAgentStatusBatch(chains, daemonKey, applyBatch, isCurrent = () => true) {
  const previous = chains.get(daemonKey) || Promise.resolve()
  const current = previous.catch(() => {}).then(() => isCurrent() ? applyBatch() : undefined)
  chains.set(daemonKey, current)
  try {
    return await current
  } finally {
    if (chains.get(daemonKey) === current) chains.delete(daemonKey)
  }
}
