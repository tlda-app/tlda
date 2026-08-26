// Message-level checks are all-or-nothing and stay that way: a batch from the
// wrong daemon, the wrong boot, or out of sequence is not partially usable.
// Row-level checks drop the ROW, never the batch — one malformed row used to
// discard every valid agent's status travelling in the same message.
function messageIsAcceptable(message, daemonKey, bootId, lastSequence) {
  if (!message?.daemon_key || message.daemon_boot_id == null) return false
  if (message.daemon_key !== daemonKey || message.daemon_boot_id !== bootId) return false
  if (message.snapshot_complete !== true || !Array.isArray(message.agents)) return false
  if (!Number.isSafeInteger(message.report_seq) || message.report_seq <= lastSequence) return false
  return true
}

export function validateDaemonAgentStatusBatch({ message, daemonKey, bootId, lastSequence = 0, agents = [], onSkip }) {
  if (!messageIsAcceptable(message, daemonKey, bootId, lastSequence)) return null

  const rows = new Map((agents || []).map(agent => [agent.id, agent]))
  const seen = new Set()
  const results = []
  for (const result of message.agents) {
    const agentId = result?.agent_id
    const agent = agentId ? rows.get(agentId) : null
    if (!agentId || seen.has(agentId)
      || !['awake', 'hibernating'].includes(result.status)
      || typeof result.activity !== 'string' || !result.activity
      || !agent || agent.route_daemon_key !== daemonKey) {
      onSkip?.(result)
      continue
    }
    seen.add(agentId)
    results.push(result)
  }
  for (const agent of rows.values()) {
    if (agent.route_daemon_key === daemonKey && !seen.has(agent.id)) {
      results.push({ agent_id: agent.id, status: 'hibernating', activity: 'unknown', tool: null })
    }
  }
  return { sequence: message.report_seq, results }
}

export function planDaemonAgentStatusBatch({ message, daemonKey, bootId, lastSequence = 0, routedAgents = [], knownAgents = [], onSkip }) {
  if (!messageIsAcceptable(message, daemonKey, bootId, lastSequence)) return null

  const knownById = new Map(knownAgents.map(agent => [agent.id, agent]))
  const admissions = []
  const kept = []
  const seen = new Set()
  for (const result of message.agents) {
    const id = result?.agent_id
    const identity = result?.identity
    const known = id ? knownById.get(id) : null
    if (!id || seen.has(id)
      || !['awake', 'hibernating'].includes(result.status)
      || typeof result.activity !== 'string' || !result.activity
      || !identity || typeof identity.friendly_name !== 'string' || !identity.friendly_name
      || typeof identity.runtime_kind !== 'string' || !identity.runtime_kind
      || (known?.route_daemon_key && known.route_daemon_key !== daemonKey)) {
      onSkip?.(result)
      continue
    }
    admissions.push({
      id,
      create: !known,
      friendly_name: identity.friendly_name,
      runtime_kind: identity.runtime_kind,
    })
    seen.add(id)
    kept.push(result)
  }

  const admittedRows = admissions.map(admission => ({ id: admission.id, route_daemon_key: daemonKey }))
  const accepted = validateDaemonAgentStatusBatch({
    // The rows this plan rejected are already gone; passing the raw message would
    // hand them straight back to the row checks below.
    message: { ...message, agents: kept },
    daemonKey,
    bootId,
    lastSequence,
    agents: [...routedAgents, ...admittedRows],
    onSkip,
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
