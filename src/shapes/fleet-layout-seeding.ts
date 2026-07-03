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
  ].slice(0, panelCount)

  return Array.from({ length: panelCount }, (_, i) => {
    if (existingChatFilters[i]) return existingChatFilters[i]!
    const name = topAgents[i]?.friendly_name as string | undefined
    return name ? [[['from', name]], [['to', name]]] : []
  })
}
