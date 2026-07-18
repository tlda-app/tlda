import { getFleetAgentDirectoryRows, type FleetAgentDirectoryRowModel } from './FleetAgentDirectoryModel.ts'

export function isOnlyOwnedChat(
  ownedFleetShapes: Array<{ id: string; type: string }>,
  chatShapeId: string,
): boolean {
  const ownedChats = ownedFleetShapes.filter((shape) => shape.type === 'fleet-chat')
  return ownedChats.length === 1 && ownedChats[0]?.id === chatShapeId
}

function lastActiveMs(agent: any): number {
  if (typeof agent?._ts === 'number') return agent._ts
  const raw = agent?.last_active || agent?.last_seen || agent?.registered_at
  const parsed = raw ? new Date(raw).getTime() : 0
  return Number.isFinite(parsed) ? parsed : 0
}

export function getUnreadAgentRailRows(
  agents: any[],
  unreadCounts: Record<string, number>,
): FleetAgentDirectoryRowModel[] {
  return getFleetAgentDirectoryRows(agents)
    .filter((row) => (unreadCounts[row.id] || 0) > 0)
    .sort((a, b) => lastActiveMs(b.agent) - lastActiveMs(a.agent))
}
