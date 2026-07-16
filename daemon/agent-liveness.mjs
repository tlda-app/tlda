export function createAgentLiveness({
  getAgents,
  listSessions,
  sendMsg,
  log,
  livenessRefreshMs = parseInt(process.env.TLDA_AGENT_LIVENESS_REFRESH_MS, 10) || 30_000,
  setIntervalFn = setInterval,
} = {}) {
  const alivenessCache = new Map()
  let refreshInterval = null

  function clearTransientMissingState() {
    alivenessCache.clear()
  }

  function noteActivity(agentId) {
    const agent = (getAgents?.() || []).find(a => a.id === agentId)
    if (!agent?.tmux_session) return
    alivenessCache.set(agent.tmux_session, true)
    agent.last_seen = new Date().toISOString()
  }

  async function check() {
    return { ok: true, disabled: true }
  }

  async function reportHostedSessions(reason = 'session-sync') {
    if (!listSessions || !sendMsg) return
    let liveSessions
    try {
      const result = await listSessions()
      liveSessions = new Set(result.sessions || [])
    } catch (e) {
      log?.warn?.(`agent liveness session report failed (${reason}): ${e.message}`)
      return
    }
    const hostedAgents = (getAgents?.() || []).filter(agent =>
      agent &&
      !agent.dead &&
      !agent.human &&
      agent.tmux_session &&
      !agent.metadata?.shell
    )
    const checked_agent_ids = []
    const agent_ids = []
    for (const agent of hostedAgents) {
      checked_agent_ids.push(agent.id)
      const alive = liveSessions.has(agent.tmux_session)
      alivenessCache.set(agent.tmux_session, alive)
      if (alive) agent_ids.push(agent.id)
    }
    if (!checked_agent_ids.length) return
    sendMsg({
      type: 'agent-liveness',
      agent_ids,
      checked_agent_ids,
      reason,
      ts: new Date().toISOString(),
    })
  }

  function start() {
    void reportHostedSessions('periodic-hosted-session-refresh')
    if (refreshInterval) return
    refreshInterval = setIntervalFn(() => {
      void reportHostedSessions('periodic-hosted-session-refresh')
    }, livenessRefreshMs)
    refreshInterval?.unref?.()
  }

  return {
    alivenessCache,
    check,
    clearTransientMissingState,
    noteActivity,
    reportHostedSessions,
    start,
  }
}
