export const DAEMON_EVENT_ROUTE_FAMILIES = Object.freeze([
  'daemon-agent-status',
  'daemon-liveness-batch',
  'daemon-agent-liveness',
  'daemon-agent-activity',
  'daemon-activity-event',
])

export function daemonEventSeatDecision(fleetStore, {
  agentId,
  daemonKey,
  family,
  log = console,
} = {}) {
  if (!fleetStore || !agentId || !daemonKey) return { seat: null, accepted: false, rejection_reason: 'missing-input' }
  const seat = fleetStore.getCurrentAgentSeat?.(agentId) || null
  if (!seat) {
    log?.debug?.(`[fleet-daemon] ignored ${family || 'daemon event'} for ${agentId}: no current seat`)
    return { seat: null, accepted: false, rejection_reason: 'no-current-seat' }
  }
  if (seat.daemon_key !== daemonKey) {
    log?.warn?.(`[fleet-daemon] ignored ${family || 'daemon event'} for ${agentId}: current seat daemon=${seat.daemon_key || 'none'} ws daemon=${daemonKey}`)
    return { seat, accepted: false, rejection_reason: 'daemon-key-mismatch' }
  }
  return { seat, accepted: true, rejection_reason: null }
}

export function currentSeatForDaemonEvent(fleetStore, options = {}) {
  const decision = daemonEventSeatDecision(fleetStore, options)
  return decision.accepted ? decision.seat : null
}
