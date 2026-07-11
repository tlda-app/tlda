// @ts-ignore — vanilla JS module
import { getEvents, getHumanName } from '../fleet/fleet-data.mjs'
// @ts-ignore — vanilla JS module
import { recentChatTargetAgents } from '../fleet/layout-targets.mjs'

export type FleetChatFilter = [string, string][][]

export function defaultFleetLayoutChatFilters({
  agents,
  humanId,
  existingChatFilters,
  panelCount,
}: {
  agents: any[]
  humanId: string
  existingChatFilters: (FleetChatFilter | undefined)[]
  panelCount: number
}): FleetChatFilter[] {
  const nonHuman = agents.filter((a: any) => a.id !== humanId && !a.human)
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
  const recentChatAgents = recentChatTargetAgents(getEvents(), deduped, humanId, getHumanName(), panelCount)
  const recentIds = new Set(recentChatAgents.map((a: any) => a.id || a.friendly_name))
  const topAgents = [
    ...recentChatAgents,
    ...deduped.filter((a: any) => !recentIds.has(a.id || a.friendly_name)),
  ]

  const usedFilters = new Set<string>()
  let nextAgent = 0

  return Array.from({ length: panelCount }, (_, i) => {
    const existing = existingChatFilters[i]
    if (existing?.length) {
      const key = JSON.stringify(existing)
      if (!usedFilters.has(key)) {
        usedFilters.add(key)
        return existing
      }
    }

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
