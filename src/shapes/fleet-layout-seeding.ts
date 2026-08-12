import { labelsForAgent } from '../../shared/fleet-labels.mjs'

export type FleetChatFilter = [string, string][][]

function labelsForHuman(humanId: string, humanName?: string) {
  return new Set([humanId, humanName].filter(Boolean))
}

function eventOrder(event: any, index: number) {
  const ts = event?.timestamp ? Date.parse(event.timestamp) : NaN
  const time = Number.isNaN(ts) ? 0 : ts
  const id = Number(event?._dbId ?? event?.id ?? 0) || 0
  return { time, id, index }
}

function agentForLabel(label: string | null, agents: any[]) {
  if (!label) return null
  return agents.find((agent: any) => labelsForAgent(agent).includes(label)) || null
}

function recentChatTargetAgents(
  events: any[] | undefined,
  agents: any[],
  humanId: string,
  humanName: string | undefined,
  limit: number,
) {
  if (!humanId && !humanName) return []
  const humanLabels = labelsForHuman(humanId, humanName)
  const ranked = [...(events || [])]
    .map((event, index) => ({ event, order: eventOrder(event, index) }))
    .filter(({ event }) => (event?.type || event?.event_type) === 'chat')
    .sort((a, b) =>
      (b.order.time - a.order.time) ||
      (b.order.id - a.order.id) ||
      (b.order.index - a.order.index))

  const seen = new Set<string>()
  const result: any[] = []
  for (const { event } of ranked) {
    const from = event.from || event.from_id
    const recipients = Array.isArray(event.recipients) ? event.recipients : []
    const toCandidates = recipients.length ? recipients : [event.to || event.to_id].filter(Boolean)
    const otherLabels = humanLabels.has(from)
      ? toCandidates
      : toCandidates.some((to: string) => humanLabels.has(to))
        ? [from]
        : []
    for (const otherLabel of otherLabels) {
      const agent = agentForLabel(otherLabel, agents)
      if (!agent || agent.human) continue
      const key = agent.id || agent.friendly_name
      if (!key || seen.has(key)) continue
      seen.add(key)
      result.push(agent)
      if (result.length >= limit) return result
    }
  }
  return result
}

// Creating the default layout is a complete teardown and a complete recreation.
// Chat targets are seeded from the live roster every time; nothing is carried
// over from the layout being replaced. Carrying the previous panels' filters
// forward meant a chat aimed at an agent that no longer existed was recreated
// into every subsequent layout forever — one such corpse, pointed at an agent
// gone since 7/13, is what kept the unread-sender rail permanently suppressed.
export function defaultFleetLayoutChatFilters({
  agents,
  events,
  humanId,
  humanName,
  panelCount,
}: {
  agents: any[]
  events?: any[]
  humanId: string
  humanName?: string
  panelCount: number
}): FleetChatFilter[] {
  const nonHuman = agents.filter((a: any) => a.id !== humanId && !a.human && !a.dead)
  const sorted = [...nonHuman].sort((a: any, b: any) => {
    const ta = a.last_seen ? new Date(a.last_seen).getTime() : 0
    const tb = b.last_seen ? new Date(b.last_seen).getTime() : 0
    return tb - ta
  })
  const seenNames = new Set<string>()
  const deduped = sorted.filter((a: any) => {
    const name = a.friendly_name as string | undefined
    if (!name || seenNames.has(name)) return false
    seenNames.add(name)
    return true
  })
  const recentChatAgents = recentChatTargetAgents(events, deduped, humanId, humanName, panelCount)
  const recentIds = new Set(recentChatAgents.map((a: any) => a.id || a.friendly_name))
  const topAgents = [
    ...recentChatAgents,
    ...deduped.filter((a: any) => !recentIds.has(a.id || a.friendly_name)),
  ]
  const usedFilters = new Set<string>()
  let nextAgent = 0

  return Array.from({ length: panelCount }, () => {
    while (nextAgent < topAgents.length) {
      const name = topAgents[nextAgent++]?.friendly_name as string | undefined
      if (!name) continue
      const filter: FleetChatFilter = [[['from', name]], [['to', name]]]
      const key = JSON.stringify(filter)
      if (usedFilters.has(key)) continue
      usedFilters.add(key)
      return filter
    }
    return []
  })
}
