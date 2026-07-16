export const POSITIVE_LIVENESS_TTL_MS = 90_000
export const HUMAN_HEARTBEAT_TTL_MS = POSITIVE_LIVENESS_TTL_MS

export const RUNTIME_STATUS = Object.freeze({
  AWAKE: 'awake',
  HIBERNATING: 'hibernating',
  DEAD: 'dead',
  SHELL: 'shell',
  HUMAN: 'human',
  HUMAN_AWAY: 'human-away',
})

export const ROUTE_STATE = Object.freeze({
  ROUTABLE: 'routable',
  UNROUTABLE: 'unroutable',
  DAEMON_DISCONNECTED: 'daemon-disconnected',
  SEAT_MISSING: 'seat-missing',
})

export const LIVENESS = Object.freeze({
  ALIVE: 'alive',
  DEAD: 'dead',
  WEDGED: 'wedged',
  UNKNOWN: 'unknown',
})

export function createAgentRuntimeStatusStore({
  ttlMs = POSITIVE_LIVENESS_TTL_MS,
  now = () => Date.now(),
  getSeat = () => null,
  isDaemonConnected = () => false,
  onChange = () => {},
} = {}) {
  const evidenceByAgent = new Map()

  function evidenceFor(agentId) {
    if (!agentId) return null
    return evidenceByAgent.get(agentId) || null
  }

  function update(agentId, patch = {}) {
    if (!agentId) return null
    const previous = evidenceByAgent.get(agentId) || {}
    const ts = Number.isFinite(patch.atMs) ? patch.atMs : now()
    const next = {
      ...previous,
      ...patch,
      agent_id: agentId,
      updated_at_ms: ts,
      updated_at: new Date(ts).toISOString(),
    }
    delete next.atMs
    evidenceByAgent.set(agentId, next)
    onChange(agentId)
    return next
  }

  function markAlive(agentId, source, detail = {}) {
    return update(agentId, {
      liveness: LIVENESS.ALIVE,
      liveness_source: source,
      liveness_reason: detail.reason || null,
      liveness_at_ms: Number.isFinite(detail.atMs) ? detail.atMs : now(),
      liveness_at: new Date(Number.isFinite(detail.atMs) ? detail.atMs : now()).toISOString(),
      tmux_session: detail.tmux_session || detail.tmuxSession || null,
      pid: detail.pid || null,
    })
  }

  function markNotAlive(agentId, source, detail = {}) {
    const state = detail.state === LIVENESS.WEDGED ? LIVENESS.WEDGED : LIVENESS.DEAD
    return update(agentId, {
      liveness: state,
      liveness_source: source,
      liveness_reason: detail.reason || null,
      liveness_at_ms: Number.isFinite(detail.atMs) ? detail.atMs : now(),
      liveness_at: new Date(Number.isFinite(detail.atMs) ? detail.atMs : now()).toISOString(),
      tmux_session: detail.tmux_session || detail.tmuxSession || null,
      pid: detail.pid || null,
    })
  }

  function markUnknown(agentId, source, detail = {}) {
    return update(agentId, {
      liveness: LIVENESS.UNKNOWN,
      liveness_source: source,
      liveness_reason: detail.reason || null,
      liveness_at_ms: Number.isFinite(detail.atMs) ? detail.atMs : now(),
      liveness_at: new Date(Number.isFinite(detail.atMs) ? detail.atMs : now()).toISOString(),
      tmux_session: detail.tmux_session || detail.tmuxSession || null,
      pid: detail.pid || null,
    })
  }

  function updateActivity(agentId, activity, detail = {}) {
    return update(agentId, {
      activity: activity || 'unknown',
      activity_tool: detail.tool || null,
      activity_at_ms: Number.isFinite(detail.atMs) ? detail.atMs : now(),
      activity_at: new Date(Number.isFinite(detail.atMs) ? detail.atMs : now()).toISOString(),
    })
  }

  function clear(agentId) {
    if (!agentId) return
    if (evidenceByAgent.delete(agentId)) onChange(agentId)
  }

  function project(agent) {
    return projectAgentRuntimeStatus(agent, evidenceFor(agent?.id), {
      nowMs: now(),
      ttlMs,
      seat: agent?.id ? getSeat(agent.id) : null,
      isDaemonConnected,
    })
  }

  function isAwake(agentId) {
    return project({ id: agentId }).status === RUNTIME_STATUS.AWAKE
  }

  return {
    evidenceFor,
    update,
    markAlive,
    markNotAlive,
    markUnknown,
    updateActivity,
    clear,
    project,
    isAwake,
    ttlMs,
  }
}

export function projectAgentRuntimeStatus(agent, evidence = null, {
  nowMs = Date.now(),
  ttlMs = POSITIVE_LIVENESS_TTL_MS,
  seat = null,
  isDaemonConnected = () => false,
} = {}) {
  const metadata = agent?.metadata || {}
  const route = routeStateFor({ agent, seat, isDaemonConnected })
  const baseEvidence = {
    liveness: evidence?.liveness || LIVENESS.UNKNOWN,
    liveness_source: evidence?.liveness_source || null,
    liveness_reason: evidence?.liveness_reason || null,
    liveness_at: evidence?.liveness_at || null,
    activity: evidence?.activity || metadata.status?.state || 'unknown',
    activity_tool: evidence?.activity_tool || metadata.status?.tool || null,
    activity_at: evidence?.activity_at || metadata.status?.ts || null,
    activity_health: metadata.activityHealth || null,
  }

  if (!agent) {
    return runtimeProjection({
      status: RUNTIME_STATUS.HIBERNATING,
      activity: 'unknown',
      route,
      evidence: baseEvidence,
      reason: 'agent-missing',
      nowMs,
    })
  }

  if (agent.dead) {
    return runtimeProjection({
      status: RUNTIME_STATUS.DEAD,
      activity: baseEvidence.activity,
      route,
      evidence: baseEvidence,
      reason: 'agent-marked-dead',
      nowMs,
    })
  }

  if (agent.human) {
    const seenAgo = agent.last_seen ? nowMs - new Date(agent.last_seen).getTime() : Infinity
    const recent = seenAgo < HUMAN_HEARTBEAT_TTL_MS
    return runtimeProjection({
      status: recent ? RUNTIME_STATUS.HUMAN : RUNTIME_STATUS.HUMAN_AWAY,
      activity: baseEvidence.activity,
      route,
      evidence: baseEvidence,
      reason: recent ? 'human-recent-heartbeat' : 'human-heartbeat-stale',
      nowMs,
    })
  }

  if (metadata.shell) {
    return runtimeProjection({
      status: RUNTIME_STATUS.SHELL,
      activity: baseEvidence.activity,
      route,
      evidence: baseEvidence,
      reason: 'reserved-shell-unclaimed',
      nowMs,
    })
  }

  if (evidence?.liveness === LIVENESS.DEAD || evidence?.liveness === LIVENESS.WEDGED) {
    return runtimeProjection({
      status: RUNTIME_STATUS.HIBERNATING,
      activity: baseEvidence.activity,
      route,
      evidence: baseEvidence,
      reason: evidence.liveness_reason || `runtime-${evidence.liveness}`,
      nowMs,
    })
  }

  if (evidence?.liveness === LIVENESS.ALIVE) {
    const ageMs = Number.isFinite(evidence.liveness_at_ms) ? nowMs - evidence.liveness_at_ms : Infinity
    if (ageMs <= ttlMs) {
      return runtimeProjection({
        status: RUNTIME_STATUS.AWAKE,
        activity: baseEvidence.activity,
        route,
        evidence: { ...baseEvidence, positive_age_ms: Math.max(0, ageMs) },
        reason: evidence.liveness_source || 'positive-runtime-evidence',
        nowMs,
      })
    }
    return runtimeProjection({
      status: RUNTIME_STATUS.HIBERNATING,
      activity: baseEvidence.activity,
      route,
      evidence: { ...baseEvidence, positive_age_ms: Number.isFinite(ageMs) ? Math.max(0, ageMs) : null },
      reason: `positive-liveness-expired-after-${ttlMs}ms`,
      nowMs,
    })
  }

  return runtimeProjection({
    status: RUNTIME_STATUS.HIBERNATING,
    activity: baseEvidence.activity,
    route,
    evidence: baseEvidence,
    reason: baseEvidence.liveness_reason || 'no-current-positive-runtime-evidence',
    nowMs,
  })
}

function routeStateFor({ agent, seat, isDaemonConnected }) {
  if (!agent?.id) return { state: ROUTE_STATE.UNROUTABLE, reason: 'agent-missing' }
  if (agent.dead) return { state: ROUTE_STATE.UNROUTABLE, reason: 'agent-dead' }
  if (!seat) return { state: ROUTE_STATE.SEAT_MISSING, reason: 'current-seat-missing' }
  if (!seat.daemon_key || !seat.tmux_session || !seat.session_id) {
    return { state: ROUTE_STATE.UNROUTABLE, reason: 'current-seat-incomplete', seat }
  }
  if (!isDaemonConnected(seat.daemon_key)) {
    return { state: ROUTE_STATE.DAEMON_DISCONNECTED, reason: 'daemon-disconnected', seat }
  }
  return { state: ROUTE_STATE.ROUTABLE, reason: 'current-seat-routable', seat }
}

function runtimeProjection({ status, activity, route, evidence, reason, nowMs }) {
  return {
    status,
    activity: activity || 'unknown',
    route_state: route.state,
    route_reason: route.reason,
    route: route.seat ? {
      daemon_key: route.seat.daemon_key || null,
      session_id: route.seat.session_id || null,
      tmux_session: route.seat.tmux_session || null,
    } : null,
    evidence,
    reason,
    updated_at: new Date(nowMs).toISOString(),
  }
}
