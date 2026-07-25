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

  // Describe what is RUNNING, and let the server replace what it had.
  //
  //   "It doesn't need to enumerate all of its agents to know who's running a
  //    process. It just enumerates running processes."
  //   "It can just send the complete list, and the server can wipe its old list."
  //   "It doesn't even have to compute a diff. That's a waste of computation.
  //    You're not gonna have more than 20 or so agents on a box."
  //                                                      — Skip, 2026-07-25
  //
  // The old shape called listSessions(), threw the answer away, and then walked
  // every agent this daemon had ever hosted (378 on the Mini, none removed since
  // 2026-07-06) asking "is yours in the set?" — re-asserting every 30s that ~190
  // sleeping agents were still asleep. That walk is what the profiler traced to
  // ~1.24M roster comparisons per batch.
  //
  // No list is carried between reports, so nothing accumulates and nothing needs
  // pruning. A dropped message costs nothing: the next one is complete and
  // self-correcting. An agent coming back needs no edge detection — its session
  // is simply present in the next report.
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
    // Resolve the RUNNING sessions to agent ids — iteration is over what is
    // running (~20), not over what was ever hosted. The server is not told about
    // tmux at all; session naming is local information and stays on this box.
    const agentIdBySession = new Map()
    for (const agent of getAgents?.() || []) {
      if (agent?.tmux_session && agent.id) agentIdBySession.set(agent.tmux_session, agent.id)
    }
    const running_agent_ids = []
    for (const session of liveSessions) {
      const agentId = agentIdBySession.get(session)
      if (agentId) running_agent_ids.push(agentId)
    }
    reportSeq += 1
    const reportedAt = new Date().toISOString()
    sendMsg({
      type: 'agent-liveness-snapshot',
      running_agent_ids,
      reason,
      ts: reportedAt,
      daemon_key: daemonKey,
      daemon_boot_id: daemonBootId,
      report_seq: reportSeq,
      report_reason: reason,
      reported_at: reportedAt,
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
