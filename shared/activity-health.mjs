export const ACTIVITY_HEALTH_OK = 'ok'
export const ACTIVITY_HEALTH_UNAVAILABLE = 'unavailable'
export const ACTIVITY_HEALTH_UNKNOWN = 'unknown'

export const ACTIVITY_HEALTH_BOUNDARIES = {
  NO_TMUX: 'no-tmux',
  NO_HARNESS_KIND: 'no-harness-kind',
  WATCH_STAT_FAILED: 'watch-stat-failed',
  WATCH_CREATE_FAILED: 'watch-create-failed',
  WATCH_UPDATE_FAILED: 'watch-update-failed',
  WATCH_START_FAILED: 'watch-start-failed',
  WATCH_RUNTIME_ERROR: 'watch-runtime-error',
  WATCH_ACK_FAILED: 'watch-ack-failed',
  WATCH_DELIVERY_FAILED: 'watch-delivery-failed',
  WATCH_ATTACHED: 'watch-attached',
  LAST_ACTIVITY: 'last-activity',
  TRANSPORT_DISCONNECTED: 'transport-disconnected',
  TRANSPORT_CONNECTED: 'transport-connected',
}

const BOUNDARY_LABELS = {
  [ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX]: 'no tmux',
  [ACTIVITY_HEALTH_BOUNDARIES.NO_HARNESS_KIND]: 'no harness',
  [ACTIVITY_HEALTH_BOUNDARIES.WATCH_STAT_FAILED]: 'stat failed',
  [ACTIVITY_HEALTH_BOUNDARIES.WATCH_CREATE_FAILED]: 'watch failed',
  [ACTIVITY_HEALTH_BOUNDARIES.WATCH_UPDATE_FAILED]: 'update failed',
  [ACTIVITY_HEALTH_BOUNDARIES.WATCH_START_FAILED]: 'start failed',
  [ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR]: 'runtime error',
  [ACTIVITY_HEALTH_BOUNDARIES.WATCH_ACK_FAILED]: 'ack failed',
  [ACTIVITY_HEALTH_BOUNDARIES.WATCH_DELIVERY_FAILED]: 'delivery failed',
  [ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED]: 'watching',
  [ACTIVITY_HEALTH_BOUNDARIES.LAST_ACTIVITY]: 'activity ok',
  [ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_DISCONNECTED]: 'daemon down',
  [ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_CONNECTED]: 'daemon up',
}

const WATCHER_FAILURE_BOUNDARIES = new Set([
  ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX,
  ACTIVITY_HEALTH_BOUNDARIES.NO_HARNESS_KIND,
  ACTIVITY_HEALTH_BOUNDARIES.WATCH_STAT_FAILED,
  ACTIVITY_HEALTH_BOUNDARIES.WATCH_CREATE_FAILED,
  ACTIVITY_HEALTH_BOUNDARIES.WATCH_UPDATE_FAILED,
  ACTIVITY_HEALTH_BOUNDARIES.WATCH_START_FAILED,
  ACTIVITY_HEALTH_BOUNDARIES.WATCH_RUNTIME_ERROR,
  ACTIVITY_HEALTH_BOUNDARIES.WATCH_ACK_FAILED,
  ACTIVITY_HEALTH_BOUNDARIES.WATCH_DELIVERY_FAILED,
])

export function activityHealthClearedBoundaries(recoveryBoundary) {
  if (recoveryBoundary === ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED) {
    return WATCHER_FAILURE_BOUNDARIES
  }
  if (recoveryBoundary === ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_CONNECTED) {
    return new Set([ACTIVITY_HEALTH_BOUNDARIES.TRANSPORT_DISCONNECTED])
  }
  return new Set([recoveryBoundary])
}

export function activityHealthKey(agentId, boundary) {
  return `${agentId || 'unknown'}:${boundary || 'unknown'}`
}

export function isActivityHealthOk(health) {
  return health?.state === ACTIVITY_HEALTH_OK
}

export function normalizeActivityHealth(input = {}, now = new Date()) {
  const state = input.state === ACTIVITY_HEALTH_OK ||
    input.state === ACTIVITY_HEALTH_UNAVAILABLE ||
    input.state === ACTIVITY_HEALTH_UNKNOWN
    ? input.state
    : ACTIVITY_HEALTH_UNKNOWN
  const boundary = input.boundary || (state === ACTIVITY_HEALTH_OK
    ? ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED
    : null)
  const ts = input.ts || now.toISOString()
  const lastKnownGoodAt = state === ACTIVITY_HEALTH_OK
    ? (input.lastKnownGoodAt || ts)
    : (input.lastKnownGoodAt || null)
  return {
    state,
    boundary,
    reason: input.reason || null,
    ts,
    lastKnownGoodAt,
    lastActivityAt: input.lastActivityAt || null,
    sessionId: input.sessionId || null,
    jsonlPath: input.jsonlPath || null,
  }
}

export function activityHealthLastKnownGoodAgeMs(health, nowMs = Date.now()) {
  const t = health?.lastKnownGoodAt ? Date.parse(health.lastKnownGoodAt) : NaN
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null
}

export function formatActivityHealthAge(ms) {
  if (ms == null) return 'never'
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 48 * 3600_000) return `${Math.round(ms / 3600_000)}h`
  return `${Math.round(ms / 86400_000)}d`
}

export function formatActivityHealthStatus(health, { nowMs = Date.now(), idleText = '' } = {}) {
  if (!health) return idleText
  const boundary = BOUNDARY_LABELS[health.boundary] || health.boundary || 'activity'
  if (health.state === ACTIVITY_HEALTH_OK) return idleText
  const age = formatActivityHealthAge(activityHealthLastKnownGoodAgeMs(health, nowMs))
  const state = health.state === ACTIVITY_HEALTH_UNKNOWN ? 'unknown' : 'unavailable'
  return `${state}:${boundary}:${age}`
}

export function activityHealthIncidentPayload(agent, health, now = new Date()) {
  const agentId = agent?.id || null
  const key = activityHealthKey(agentId, health?.boundary)
  return {
    key,
    severity: health?.state === ACTIVITY_HEALTH_UNKNOWN ? 'warning' : 'critical',
    component: 'activity-health',
    operation: health?.boundary || 'unknown',
    actors: {
      agentId,
      agentName: agent?.friendly_name || agent?.name || null,
      machineId: agent?.machine_id || null,
      envName: agent?.env_name || null,
      tmuxSession: agent?.tmux_session || null,
    },
    impact: `Activity visibility for ${agent?.friendly_name || agentId || 'unknown agent'} is ${health?.state || 'unknown'} at ${health?.boundary || 'unknown boundary'}.`,
    evidence: {
      state: health?.state || null,
      boundary: health?.boundary || null,
      reason: health?.reason || null,
      observedAt: health?.ts || now.toISOString(),
      lastKnownGoodAt: health?.lastKnownGoodAt || null,
      lastKnownGoodAgeMs: activityHealthLastKnownGoodAgeMs(health, now.getTime()),
      lastActivityAt: health?.lastActivityAt || null,
      sessionId: health?.sessionId || null,
      jsonlPath: health?.jsonlPath || null,
    },
    error: null,
  }
}

export function activityHealthIncidentDecision(incidents = {}, agent, health) {
  const activeIncidents = incidents && typeof incidents === 'object' ? incidents : {}
  if (isActivityHealthOk(health)) {
    const clearedBoundaries = activityHealthClearedBoundaries(health?.boundary)
    return {
      raise: null,
      clearKeys: Object.entries(activeIncidents)
        .filter(([, incident]) => !incident?.clearedAt && clearedBoundaries.has(incident?.boundary))
        .map(([key]) => key),
    }
  }
  const key = activityHealthKey(agent?.id, health?.boundary)
  const existing = activeIncidents[key]
  return {
    raise: existing && !existing.clearedAt ? null : key,
    clearKeys: [],
  }
}

export function activityHealthForProjection(metadata = {}, runtimeStatus = null, {
  allowRoutableNoTmuxSuppression = false,
} = {}) {
  const health = metadata?.activityHealth || null
  const incidents = metadata?.activityHealthIncidents && typeof metadata.activityHealthIncidents === 'object'
    ? Object.values(metadata.activityHealthIncidents)
      .filter(incident => incident && !incident.clearedAt)
      .sort((a, b) => Date.parse(b.raisedAt || 0) - Date.parse(a.raisedAt || 0))
    : []
  const incident = incidents[0]
  const healthTs = Date.parse(health?.ts || 0)
  const incidentTs = Date.parse(incident?.raisedAt || 0)
  const incidentIsLatest = incident && (
    !Number.isFinite(healthTs) ||
    !Number.isFinite(incidentTs) ||
    incidentTs > healthTs
  )
  const projected = incidentIsLatest ? {
    ...(health || {}),
    state: incident.state || ACTIVITY_HEALTH_UNAVAILABLE,
    boundary: incident.boundary || health?.boundary || null,
    ts: incident.raisedAt || health?.ts || null,
  } : health
  if (
    allowRoutableNoTmuxSuppression &&
    projected?.boundary === ACTIVITY_HEALTH_BOUNDARIES.NO_TMUX &&
    runtimeStatus?.route_state === 'routable'
  ) {
    return null
  }
  return projected
}
