export function unroutedNativeDescendantIds(agents, parentAgentId) {
  const childrenByParent = new Map()
  for (const agent of agents || []) {
    if (!agent?.parent_agent_id || agent.route_present) continue
    const children = childrenByParent.get(agent.parent_agent_id) || []
    children.push(agent)
    childrenByParent.set(agent.parent_agent_id, children)
  }

  const ids = []
  const pending = [...(childrenByParent.get(parentAgentId) || [])]
  while (pending.length) {
    const child = pending.shift()
    ids.push(child.id)
    pending.push(...(childrenByParent.get(child.id) || []))
  }
  return ids
}
