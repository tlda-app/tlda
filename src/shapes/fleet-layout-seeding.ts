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

function targetName(filter: FleetChatFilter) {
  if (filter.length !== 2) return null
  const from = filter.find(group => group.length === 1 && group[0]?.[0] === 'from')?.[0]?.[1]
  const to = filter.find(group => group.length === 1 && group[0]?.[0] === 'to')?.[0]?.[1]
  return from && from === to ? from : null
}

function lastOutboundOrder(events: any[] | undefined, agents: any[], humanId: string, humanName?: string) {
  const humanLabels = labelsForHuman(humanId, humanName)
  const result = new Map<string, ReturnType<typeof eventOrder>>()
  for (const [index, event] of (events || []).entries()) {
    if ((event?.type || event?.event_type) !== 'chat') continue
    const from = event.from || event.from_id
    const recipients = Array.isArray(event.recipients) ? event.recipients : [event.to || event.to_id].filter(Boolean)
    if (!humanLabels.has(from)) continue
    const order = eventOrder(event, index)
    for (const label of recipients) {
      const name = agentForLabel(label, agents)?.friendly_name
      if (!name) continue
      const prior = result.get(name)
      if (!prior || order.time > prior.time || (order.time === prior.time && order.id > prior.id)) {
        result.set(name, order)
      }
    }
  }
  return result
}

export function defaultFleetLayoutChatFilters({
  agents,
  events,
  humanId,
  humanName,
  panelCount,
  existingFilters = [],
}: {
  agents: any[]
  events?: any[]
  humanId: string
  humanName?: string
  panelCount: number
  existingFilters?: FleetChatFilter[]
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
  const liveNames = new Set(deduped.map((agent: any) => agent.friendly_name).filter(Boolean))
  const outbound = lastOutboundOrder(events, deduped, humanId, humanName)
  const preserved = existingFilters
    .map((filter, index) => ({ filter, index, name: targetName(filter) }))
    .filter(({ name }) => !name || liveNames.has(name))
    .sort((a, b) => {
      if (existingFilters.length <= panelCount) return a.index - b.index
      const ao = a.name ? outbound.get(a.name) : undefined
      const bo = b.name ? outbound.get(b.name) : undefined
      return ((bo?.time || 0) - (ao?.time || 0)) || ((bo?.id || 0) - (ao?.id || 0)) || (a.index - b.index)
    })
    .slice(0, panelCount)
    .map(({ filter }) => filter)

  for (const filter of preserved) usedFilters.add(JSON.stringify(filter))
  let nextAgent = 0

  return Array.from({ length: panelCount }, (_, index) => {
    if (preserved[index]) return preserved[index]
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
