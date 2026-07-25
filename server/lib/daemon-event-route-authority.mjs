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
  if (!seat) return { seat: null, accepted: false, rejection_reason: 'no-current-seat' }
  if (seat.daemon_key !== daemonKey) {
    return { seat, accepted: false, rejection_reason: 'daemon-key-mismatch', seat_daemon_key: seat.daemon_key || null }
  }
  return { seat, accepted: true, rejection_reason: null }
}

// Logging belongs to the caller that actually ignores the event, not to the
// decision itself. The liveness batch consults this same authority but does NOT
// ignore every rejection — it still honours a death report for an unseated
// agent — so a rejection logged as "ignored" in here was a lie on that path, and
// it was the lie printed ~190 times per batch.
export function currentSeatForDaemonEvent(fleetStore, options = {}) {
  const { agentId, daemonKey, family, log = console } = options
  const decision = daemonEventSeatDecision(fleetStore, options)
  if (decision.accepted) return decision.seat
  if (decision.rejection_reason === 'daemon-key-mismatch') {
    log?.warn?.(`[fleet-daemon] ignored ${family || 'daemon event'} for ${agentId}: current seat daemon=${decision.seat_daemon_key || 'none'} ws daemon=${daemonKey}`)
  } else {
    log?.debug?.(`[fleet-daemon] ignored ${family || 'daemon event'} for ${agentId}: ${decision.rejection_reason}`)
  }
  return null
}
