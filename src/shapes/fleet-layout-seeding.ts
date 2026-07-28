export type FleetChatFilter = [string, string][][]

// Creating the default layout is a complete teardown and a complete recreation.
// Chat targets are seeded from the live roster every time; nothing is carried
// over from the layout being replaced. Carrying the previous panels' filters
// forward meant a chat aimed at an agent that no longer existed was recreated
// into every subsequent layout forever — one such corpse, pointed at an agent
// gone since 7/13, is what kept the unread-sender rail permanently suppressed.
export function defaultFleetLayoutChatFilters({
  agents,
  humanId,
  panelCount,
}: {
  agents: any[]
  humanId: string
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
  const usedFilters = new Set<string>()
  let nextAgent = 0

  return Array.from({ length: panelCount }, () => {
    while (nextAgent < deduped.length) {
      const name = deduped[nextAgent++]?.friendly_name as string | undefined
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
