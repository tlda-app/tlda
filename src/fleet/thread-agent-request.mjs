export function threadAgentRequest(descriptor, taskAgent, currentProject) {
  const view = descriptor?.view || {}
  const agent = view.agent || taskAgent
  if (!agent) return null
  const filters = {
    eventOnly: true,
    historyOnly: true,
    currentProject,
    throwOnError: true,
    ...(descriptor?.caller ? { me: descriptor.caller } : {}),
    filterExpression: `me <> ${agent}`,
  }
  const requestedTypes = Array.isArray(view.types) ? view.types : []
  if (requestedTypes.length === 1) filters.eventType = requestedTypes[0]
  else if (requestedTypes.length > 1) filters.eventTypes = requestedTypes
  return { agent, filters }
}
