// This is the liveness check list, and it never shrinks. A ledger row keeps its
// `tmux_session` after the session is gone, so every agent this daemon has ever
// launched stays here and gets re-checked and re-reported every 30s forever. On
// the Mini on 2026-07-25 that was 378 rows for `mini:default`, none removed
// since 2026-07-06.
//
// LANDMINE FOR WHOEVER FIXES THAT: do NOT fix it by deleting the ledger row.
// These rows are permission grants, and deleting them is the documented cause of
// the "wake refused: no ledger entry" failure class — it is why the delete-guard
// in rpcSpawn exists. The safe prune clears `tmux_session` (the only field that
// makes a row a liveness candidate, per the filter below) and leaves the grant
// intact, so the agent stays wakeable.
export function livenessAgentsFromProcessBindings(rows = [], { daemonKey } = {}) {
  return rows
    .filter(row => row?.id && row.daemonKey === daemonKey && row.tmuxSession)
    .map(row => ({
      id: row.id,
      tmux_session: row.tmuxSession,
      dead: false,
      human: false,
      metadata: { shell: false },
    }))
}

export function createAgentLiveness({
  getAgents,
  listSessions,
  sendMsg,
  log,
  daemonKey,
  daemonBootId,
  livenessRefreshMs = parseInt(process.env.TLDA_AGENT_LIVENESS_REFRESH_MS, 10) || 30_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const alivenessCache = new Map()
  let refreshInterval = null
  let reportSeq = 0

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
    reportSeq += 1
    const reportedAt = new Date().toISOString()
    sendMsg({
      type: 'agent-liveness',
      agent_ids,
      checked_agent_ids,
      reason,
      ts: reportedAt,
      daemon_key: daemonKey,
      daemon_boot_id: daemonBootId,
      report_seq: reportSeq,
      report_reason: reason,
      reported_at: reportedAt,
      liveness_generations: checked_agent_ids.map(agent_id => ({
        daemon_key: daemonKey,
        daemon_boot_id: daemonBootId,
        report_seq: reportSeq,
        agent_id,
      })),
    })
  }

  function start() {
    const initialReport = reportHostedSessions('periodic-hosted-session-refresh')
    if (refreshInterval) return initialReport
    refreshInterval = setIntervalFn(() => {
      void reportHostedSessions('periodic-hosted-session-refresh')
    }, livenessRefreshMs)
    refreshInterval?.unref?.()
    return initialReport
  }

  function stop() {
    if (!refreshInterval) return
    clearIntervalFn(refreshInterval)
    refreshInterval = null
  }

  return {
    alivenessCache,
    check,
    clearTransientMissingState,
    noteActivity,
    reportHostedSessions,
    start,
    stop,
  }
}
