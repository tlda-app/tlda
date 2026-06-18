import { labelsForAgent } from '../../shared/fleet-labels.mjs'

function agentMatchesLabel(agentId, label, { agents = [], humanId = null, humanName = null } = {}) {
  if (!agentId) return false
  if (agentId === label) return true
  let agent = agents.find(a => a.id === agentId)
  if (!agent && humanId && agentId === humanId) {
    agent = { id: humanId, friendly_name: humanName || 'user', status: 'human', labels: [] }
  }
  if (!agent) return false
  return labelsForAgent(agent).includes(label)
}

// Filter is DNF of terms: [[["to","skip"],["from","math"]]] or plain [["label"]] or null (match all).
// Term formats: [role, label] tuple (directional) or plain string (matches from OR to).
export function matchesFleetFilter(filter, event, context = {}) {
  if (!event) return true  // broadcast (e.g. read-receipt refresh)
  if (!filter || filter.length === 0) return true
  if ((event.from_id === 'system' || event.from === 'system') && !event.to) return true
  return filter.some(clause =>
    clause.every(term => {
      if (Array.isArray(term)) {
        const [role, label] = term
        const agentId = role === 'from' ? (event.from || event.agent) : (event.to || event.agent)
        return agentMatchesLabel(agentId, label, context)
      }
      // Plain string — match from OR to
      return agentMatchesLabel(event.from || event.agent, term, context) ||
             agentMatchesLabel(event.to || event.agent, term, context)
    })
  )
}

function termLabel(term) {
  return Array.isArray(term) ? term[1] : term
}

// Resolve a DNF filter to the broad set of agent IDs needed to fetch history for
// events that might match the live display filter. The history endpoint only
// prefilters by "involves one of these agents", so include every referenced
// participant label instead of requiring one agent to satisfy an entire clause.
export function resolveFleetFilter(filter, { agents = [], humanId = null, humanName = null } = {}) {
  if (!filter) return new Set()
  const ids = new Set()
  const allAgents = [...agents]
  if (humanId && !allAgents.some(a => a.id === humanId)) {
    allAgents.push({ id: humanId, friendly_name: humanName || 'user', status: 'human', labels: [] })
  }
  const labels = new Set()
  for (const clause of filter) {
    if (!Array.isArray(clause)) continue
    for (const term of clause) {
      const label = termLabel(term)
      if (label) labels.add(label)
    }
  }
  for (const a of allAgents) {
    const agentLabels = labelsForAgent(a)
    if ([...labels].some(label => agentLabels.includes(label))) ids.add(a.id)
  }
  return ids
}
