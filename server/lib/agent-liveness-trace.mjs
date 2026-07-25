export const DEFAULT_LIVENESS_GENERATIONS_PER_AGENT = 32
export const DEFAULT_LIVENESS_EVENTS_PER_GENERATION = 16

const PUBLIC_TRACE_FIELDS = Object.freeze([
  'agent_id', 'generation', 'stage', 'stage_at', 'server_received_at',
  'reported_at', 'report_reason', 'ws_daemon_key', 'ws_boot_id',
  'seat_identity_match', 'seat_rejection_reason', 'terminal_decision',
  'mark_alive_applied', 'liveness_state', 'liveness_source', 'liveness_at',
  'liveness_age_ms', 'reason', 'route_reason', 'projected_status',
  'changed_row_built', 'changed_row_generation',
])

export function livenessGenerationKey(generation) {
  if (!generation || !generation.agent_id) return null
  return JSON.stringify([
    generation.daemon_key,
    generation.daemon_boot_id,
    generation.report_seq,
    generation.agent_id,
  ])
}

export function publicAgentLivenessTraceEntry(entry) {
  return Object.fromEntries(PUBLIC_TRACE_FIELDS
    .filter(key => entry?.[key] !== undefined)
    .map(key => [key, entry[key]]))
}

export function createAgentLivenessTraceStore({
  generationsPerAgent = DEFAULT_LIVENESS_GENERATIONS_PER_AGENT,
  eventsPerGeneration = DEFAULT_LIVENESS_EVENTS_PER_GENERATION,
  now = () => new Date().toISOString(),
} = {}) {
  const byAgent = new Map()
  let sequence = 0

  function replaceableStageSlot(stage) {
    if (stage === 'runtime.projected') return 'runtime.projected'
    if (stage === 'agentsDelta.changedRowBuilt' || stage === 'agentsDelta.changedRowNotBuilt') return 'agentsDelta.changedRow'
    return null
  }

  function record(entry) {
    const agentId = entry?.agent_id
    const generationKey = livenessGenerationKey(entry?.generation)
    if (!agentId || !generationKey) return null
    let generations = byAgent.get(agentId)
    if (!generations) {
      generations = new Map()
      byAgent.set(agentId, generations)
    }
    let events = generations.get(generationKey)
    if (!events) {
      if (generations.size >= generationsPerAgent) {
        generations.delete(generations.keys().next().value)
      }
      events = []
      generations.set(generationKey, events)
    }
    const recorded = { ...entry, stage_at: entry.stage_at || now(), _sequence: ++sequence }
    const stageSlot = replaceableStageSlot(recorded.stage)
    if (stageSlot) {
      const previousIndex = events.findIndex(event => replaceableStageSlot(event.stage) === stageSlot)
      if (previousIndex !== -1) events.splice(previousIndex, 1)
    }
    events.push(recorded)
    if (events.length > eventsPerGeneration) events.splice(0, events.length - eventsPerGeneration)
    return recorded
  }

  function list(agentId, { limit = 200 } = {}) {
    const generations = byAgent.get(agentId)
    if (!generations) return []
    return [...generations.values()]
      .flat()
      .sort((a, b) => a._sequence - b._sequence)
      .slice(-limit)
      .map(publicAgentLivenessTraceEntry)
  }

  function generationCount(agentId) {
    return byAgent.get(agentId)?.size || 0
  }

  return { record, list, generationCount, generationsPerAgent, eventsPerGeneration }
}


export function recordLivenessProjection(traceStore, { agentId, generation, runtime, changedRowBuilt }) {
  const livenessAtMs = Date.parse(runtime?.evidence?.liveness_at || '')
  traceStore.record({
    agent_id: agentId,
    generation,
    stage: 'runtime.projected',
    liveness_state: runtime?.evidence?.liveness || null,
    liveness_source: runtime?.evidence?.liveness_source || null,
    liveness_at: runtime?.evidence?.liveness_at || null,
    liveness_age_ms: runtime?.evidence?.positive_age_ms
      ?? (Number.isFinite(livenessAtMs) ? Math.max(0, Date.now() - livenessAtMs) : null),
    reason: runtime?.reason || null,
    route_reason: runtime?.route_reason || null,
    projected_status: runtime?.status || null,
  })
  traceStore.record({
    agent_id: agentId,
    generation,
    stage: changedRowBuilt ? 'agentsDelta.changedRowBuilt' : 'agentsDelta.changedRowNotBuilt',
    changed_row_built: changedRowBuilt,
    changed_row_generation: generation,
  })
}

export function agentLivenessTraceResponse(traceStore, { agent, limit }) {
  const traces = traceStore.list(agent, { limit })
  return { ok: true, agent, count: traces.length, traces }
}
