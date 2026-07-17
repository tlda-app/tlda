import { runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'

function isDeadAgent(agent) {
  return runtimeStatusName(agent) === 'dead' || agent?.dead === true
}

function oneLiveMatch(matches, query, label) {
  if (matches.length === 0) return null
  const live = matches.filter(agent => !isDeadAgent(agent))
  if (live.length === 1) return live[0]
  if (live.length === 0 && matches.length === 1) return matches[0]
  const ids = (live.length ? live : matches).map(agent => agent.id).filter(Boolean).join(', ')
  throw new Error(`Multiple ${label} agents matched "${query}". Use the fleet id instead: ${ids}`)
}

export function resolveAgentQuery(agents, query) {
  const list = Array.isArray(agents) ? agents : []
  const byId = oneLiveMatch(list.filter(agent => agent?.id === query), query, 'id')
  if (byId) return byId

  const byName = oneLiveMatch(list.filter(agent => agent?.friendly_name === query), query, 'friendly-name')
  if (byName) return byName

  return null
}

export function agentMatchesQuery(agent, query) {
  return agent?.id === query || agent?.friendly_name === query
}
