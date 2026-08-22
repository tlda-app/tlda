export function unroutedNativeDescendantIds(agents, parentAgentId) {
  return unroutedNativeDescendantsForParents(agents, [parentAgentId]).map(item => item.descendantId)
}

export function unroutedNativeDescendantsForParents(agents, parentAgentIds) {
  const childrenByParent = new Map()
  for (const agent of agents || []) {
    if (!agent?.parent_agent_id || agent.route_present) continue
    const children = childrenByParent.get(agent.parent_agent_id) || []
    children.push(agent)
    childrenByParent.set(agent.parent_agent_id, children)
  }

  const descendants = []
  const seen = new Set()
  const pending = []
  for (const parentAgentId of parentAgentIds || []) {
    for (const child of childrenByParent.get(parentAgentId) || []) pending.push({ child, parentAgentId })
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { child, parentAgentId } = pending[cursor]
    if (!child?.id || seen.has(child.id)) continue
    seen.add(child.id)
    descendants.push({ descendantId: child.id, parentAgentId })
    for (const nested of childrenByParent.get(child.id) || []) pending.push({ child: nested, parentAgentId })
  }
  return descendants
}

export async function reconcileUnroutedNativeDescendantLiveness({
  agents,
  parentAgentIds,
  livenessFor,
  writeDurable,
  markRuntime,
}) {
  let wrote = false
  for (const item of unroutedNativeDescendantsForParents(agents, parentAgentIds)) {
    const liveness = livenessFor(item.descendantId)
    if (liveness === 'dead' || liveness === 'wedged') continue
    await writeDurable(item)
    await markRuntime(item)
    wrote = true
  }
  return wrote
}
