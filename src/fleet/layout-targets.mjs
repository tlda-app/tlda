import { labelsForAgent } from '../../shared/fleet-labels.mjs'

function labelsForHuman(humanId, humanName) {
  return new Set([humanId, humanName].filter(Boolean))
}

function eventOrder(event, index) {
  const ts = event?.timestamp ? Date.parse(event.timestamp) : NaN
  const time = Number.isNaN(ts) ? 0 : ts
  const id = Number(event?._dbId ?? event?.id ?? 0) || 0
  return { time, id, index }
}

function agentForLabel(label, agents) {
  if (!label) return null
  return agents.find((agent) => labelsForAgent(agent).includes(label)) || null
}

export function recentChatTargetAgents(events, agents, humanId, humanName, limit) {
  if (!humanId && !humanName) return []
  const humanLabels = labelsForHuman(humanId, humanName)
  const ranked = [...(events || [])]
    .map((event, index) => ({ event, order: eventOrder(event, index) }))
    .filter(({ event }) => (event?.type || event?.event_type) === 'chat')
    .sort((a, b) =>
      (b.order.time - a.order.time) ||
      (b.order.id - a.order.id) ||
      (b.order.index - a.order.index))

  const seen = new Set()
  const result = []
  for (const { event } of ranked) {
    const from = event.from || event.from_id
    const to = event.to || event.to_id
    const otherLabel = humanLabels.has(from) ? to : humanLabels.has(to) ? from : null
    const agent = agentForLabel(otherLabel, agents)
    if (!agent || agent.human) continue
    const key = agent.id || agent.friendly_name
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(agent)
    if (result.length >= limit) break
  }
  return result
}
