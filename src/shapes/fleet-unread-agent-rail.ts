import { getFleetAgentDirectoryRows, type FleetAgentDirectoryRowModel } from './FleetAgentDirectoryModel.ts'

export function isOnlyOwnedChat(
  ownedFleetShapes: Array<{ id: string; type: string }>,
  chatShapeId: string,
): boolean {
  const ownedChats = ownedFleetShapes.filter((shape) => shape.type === 'fleet-chat')
  return ownedChats.length === 1 && ownedChats[0]?.id === chatShapeId
}

/** The four fields `lastActiveMs` reads. Agents are `any` throughout
 *  `FleetAgentDirectoryModel`; this types what this function touches. */
type FleetAgentActivityFields = {
  _ts?: number
  last_active?: string | number
  last_seen?: string | number
  registered_at?: string | number
}

function lastActiveMs(agent: FleetAgentActivityFields | null | undefined): number {
  if (typeof agent?._ts === 'number') return agent._ts
  const raw = agent?.last_active || agent?.last_seen || agent?.registered_at
  const parsed = raw ? new Date(raw).getTime() : 0
  return Number.isFinite(parsed) ? parsed : 0
}

export function getUnreadAgentRailRows(
  agents: unknown[],
  unreadCounts: Record<string, number>,
  displayedUnreadSenderIds: ReadonlySet<string> = new Set(),
): FleetAgentDirectoryRowModel[] {
  return getFleetAgentDirectoryRows(agents)
    .filter((row) => (unreadCounts[row.id] || 0) > 0)
    .filter((row) => !displayedUnreadSenderIds.has(row.id))
    .sort((a, b) => lastActiveMs(b.agent) - lastActiveMs(a.agent))
}
