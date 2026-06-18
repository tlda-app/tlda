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

function isHumanParticipant(agentId, context) {
  return agentMatchesLabel(agentId, context.humanId, context) ||
    (context.humanName ? agentMatchesLabel(agentId, context.humanName, context) : false)
}

function isDmWithTarget(event, targetLabel, context) {
  if (!event || !targetLabel) return false
  if (event._activity || event.type === 'activity') return false
  const from = event.from || event.from_id || event.agent
  const to = event.to || event.to_id || null
  const agent = event.agent || event.agent_id || null
  const fromHuman = isHumanParticipant(from, context)
  const toHuman = isHumanParticipant(to, context)
  const fromTarget = agentMatchesLabel(from, targetLabel, context)
  const toTarget = agentMatchesLabel(to, targetLabel, context) || agentMatchesLabel(agent, targetLabel, context)

  if (fromHuman && toTarget) return true
  if (fromTarget && toHuman) return true
  return false
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
        if (role === 'dm') return isDmWithTarget(event, label, context)
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

export function buildFleetDmFilter(humanLabel, agentLabel) {
  if (!agentLabel) return []
  return [[['dm', agentLabel]]]
}

export function buildFleetAgentFilter(agentLabel) {
  if (!agentLabel) return []
  return [
    [['from', agentLabel]],
    [['to', agentLabel]],
  ]
}

function canonicalFilter(filter) {
  if (!Array.isArray(filter)) return ''
  return filter
    .map(clause => Array.isArray(clause)
      ? clause.map(term => Array.isArray(term) ? `${term[0]}\0${term[1]}` : `any\0${term}`).sort().join('\u0001')
      : '')
    .sort()
    .join('\u0002')
}

export function sameFleetFilter(a, b) {
  return canonicalFilter(a) === canonicalFilter(b)
}

export function classifyFleetComposerTrafficMode(filter, trafficMode, humanLabel, agentLabel) {
  if (!agentLabel) return 'custom'
  if (sameFleetFilter(filter, buildFleetDmFilter(humanLabel, agentLabel))) {
    return trafficMode === 'quiet' ? 'dm-quiet' : 'dm'
  }
  if (sameFleetFilter(filter, buildFleetAgentFilter(agentLabel))) return 'agent'
  return 'custom'
}

export function nextFleetComposerTrafficMode(currentMode) {
  if (currentMode === 'dm-quiet') return 'dm'
  if (currentMode === 'dm') return 'agent'
  return 'dm-quiet'
}

export function filterForFleetComposerTrafficMode(mode, humanLabel, agentLabel) {
  return mode === 'agent'
    ? buildFleetAgentFilter(agentLabel)
    : buildFleetDmFilter(humanLabel, agentLabel)
}
