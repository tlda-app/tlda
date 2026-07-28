export const HUMAN_HEARTBEAT_TTL_MS = 90_000

export const RUNTIME_STATUS = Object.freeze({
  AWAKE: 'awake',
  HIBERNATING: 'hibernating',
  DEAD: 'dead',
  HUMAN: 'human',
  HUMAN_AWAY: 'human-away',
})

export const LIVENESS = Object.freeze({
  ALIVE: 'alive',
  DEAD: 'dead',
  WEDGED: 'wedged',
  UNKNOWN: 'unknown',
})

export function createAgentRuntimeStatusStore({
  now = () => Date.now(),
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
    const atMs = Number.isFinite(detail.atMs) ? detail.atMs : now()
    const previous = evidenceFor(agentId)
    if (Number.isFinite(previous?.liveness_at_ms) && atMs < previous.liveness_at_ms) return previous
    const previousAliveAt = Number(previous?.liveness_at_ms)
    const continuouslyAlive = previous?.liveness === LIVENESS.ALIVE
      && Number.isFinite(previousAliveAt)
    const livenessAtMs = continuouslyAlive ? Math.max(atMs, previousAliveAt) : atMs
    return update(agentId, {
      liveness: LIVENESS.ALIVE,
      liveness_source: source,
      liveness_reason: detail.reason || null,
      liveness_at_ms: livenessAtMs,
      liveness_at: new Date(livenessAtMs).toISOString(),
      alive_since_ms: continuouslyAlive ? (previous.alive_since_ms || previousAliveAt) : atMs,
      alive_since: new Date(continuouslyAlive ? (previous.alive_since_ms || previousAliveAt) : atMs).toISOString(),
      pid: detail.pid || null,
      liveness_generation: detail.liveness_generation || null,
      liveness_daemon_key: detail.daemon_key || null,
      liveness_daemon_boot_id: detail.daemon_boot_id ?? null,
      liveness_report_seq: detail.report_seq ?? null,
    })
  }

  function markNotAlive(agentId, source, detail = {}) {
    const atMs = Number.isFinite(detail.atMs) ? detail.atMs : now()
    const previous = evidenceFor(agentId)
    if (Number.isFinite(previous?.liveness_at_ms) && atMs < previous.liveness_at_ms) return previous
    const state = detail.state === LIVENESS.WEDGED ? LIVENESS.WEDGED : LIVENESS.DEAD
    return update(agentId, {
      liveness: state,
      liveness_source: source,
      liveness_reason: detail.reason || null,
      liveness_at_ms: atMs,
      liveness_at: new Date(atMs).toISOString(),
      alive_since_ms: null,
      alive_since: null,
      pid: detail.pid || null,
      liveness_generation: detail.liveness_generation || null,
      liveness_daemon_key: detail.daemon_key || null,
      liveness_daemon_boot_id: detail.daemon_boot_id ?? null,
      liveness_report_seq: detail.report_seq ?? null,
    })
  }

  function markUnknown(agentId, source, detail = {}) {
    const atMs = Number.isFinite(detail.atMs) ? detail.atMs : now()
    const previous = evidenceFor(agentId)
    if (Number.isFinite(previous?.liveness_at_ms) && atMs < previous.liveness_at_ms) return previous
    return update(agentId, {
      liveness: LIVENESS.UNKNOWN,
      liveness_source: source,
      liveness_reason: detail.reason || null,
      liveness_at_ms: atMs,
      liveness_at: new Date(atMs).toISOString(),
      alive_since_ms: null,
      alive_since: null,
      pid: detail.pid || null,
      liveness_generation: detail.liveness_generation || null,
      liveness_daemon_key: detail.daemon_key || null,
      liveness_daemon_boot_id: detail.daemon_boot_id ?? null,
      liveness_report_seq: detail.report_seq ?? null,
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

  // Projects the agent ROW it is given. It does not look anything up: the seat
  // facts ride the row and the liveness evidence is right here. There is no
  // isAwake(agentId) beside it any more — an id is not enough to project from,
  // and the two callers that used one already held the agent row.
  function project(agent) {
    return projectAgentRuntimeStatus(agent, evidenceFor(agent?.id), {
      nowMs: now(),
    })
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
  }
}

export function projectAgentRuntimeStatus(agent, evidence = null, {
  nowMs = Date.now(),
} = {}) {
  const metadata = agent?.metadata || {}
  const baseEvidence = {
    liveness: evidence?.liveness || LIVENESS.UNKNOWN,
    liveness_source: evidence?.liveness_source || null,
    liveness_reason: evidence?.liveness_reason || null,
    liveness_at: evidence?.liveness_at || null,
    activity: evidence?.activity || metadata.status?.state || 'unknown',
    activity_tool: evidence?.activity_tool || metadata.status?.tool || null,
    activity_at: evidence?.activity_at || metadata.status?.ts || null,
    activity_health: metadata.activityHealth || null,
    liveness_generation: evidence?.liveness_generation || null,
    liveness_daemon_key: evidence?.liveness_daemon_key || null,
    liveness_daemon_boot_id: evidence?.liveness_daemon_boot_id ?? null,
    liveness_report_seq: evidence?.liveness_report_seq ?? null,
  }

  if (!agent) {
    return runtimeProjection({
      status: RUNTIME_STATUS.HIBERNATING,
      activity: 'unknown',
      evidence: baseEvidence,
      reason: 'agent-missing',
      nowMs,
    })
  }

  if (agent.dead) {
    return runtimeProjection({
      status: RUNTIME_STATUS.DEAD,
      activity: baseEvidence.activity,
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
      evidence: baseEvidence,
      reason: recent ? 'human-recent-heartbeat' : 'human-heartbeat-stale',
      nowMs,
    })
  }

  if (metadata.shell) {
    return runtimeProjection({
      status: RUNTIME_STATUS.HIBERNATING,
      activity: baseEvidence.activity,
      evidence: baseEvidence,
      reason: 'reserved-shell-unclaimed',
      nowMs,
    })
  }

  if (evidence?.liveness === LIVENESS.DEAD || evidence?.liveness === LIVENESS.WEDGED) {
    return runtimeProjection({
      status: RUNTIME_STATUS.HIBERNATING,
      activity: baseEvidence.activity,
      evidence: baseEvidence,
      reason: evidence.liveness_reason || `runtime-${evidence.liveness}`,
      nowMs,
    })
  }

  if (evidence?.liveness === LIVENESS.ALIVE) {
    return runtimeProjection({
      status: RUNTIME_STATUS.AWAKE,
      activity: baseEvidence.activity,
      evidence: baseEvidence,
      reason: evidence.liveness_source || 'positive-runtime-evidence',
      nowMs,
    })
  }

  return runtimeProjection({
    status: RUNTIME_STATUS.HIBERNATING,
    activity: baseEvidence.activity,
    evidence: baseEvidence,
    reason: baseEvidence.liveness_reason || 'no-current-positive-runtime-evidence',
    nowMs,
  })
}

function runtimeProjection({ status, activity, evidence, reason, nowMs }) {
  return {
    status,
    activity: activity || 'unknown',
    evidence,
    reason,
    updated_at: new Date(nowMs).toISOString(),
  }
}
