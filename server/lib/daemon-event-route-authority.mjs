export const DAEMON_EVENT_ROUTE_FAMILIES = Object.freeze([
  'daemon-agent-status',
  'daemon-liveness-batch',
  'daemon-agent-liveness',
  'daemon-agent-activity',
  'daemon-activity-event',
])

export function currentSeatForDaemonEvent(fleetStore, {
  agentId,
  daemonKey,
  family,
  log = console,
} = {}) {
  if (!fleetStore || !agentId || !daemonKey) return null
  const seat = fleetStore.getCurrentAgentSeat?.(agentId) || null
  if (!seat) {
    log?.debug?.(`[fleet-daemon] ignored ${family || 'daemon event'} for ${agentId}: no current seat`)
    return null
  }
  if (seat.daemon_key !== daemonKey) {
    log?.warn?.(`[fleet-daemon] ignored ${family || 'daemon event'} for ${agentId}: current seat daemon=${seat.daemon_key || 'none'} ws daemon=${daemonKey}`)
    return null
  }
  return seat
}
