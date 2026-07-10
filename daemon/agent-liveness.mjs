export function createAgentLiveness({ getAgents } = {}) {
  const alivenessCache = new Map()

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

  function start() {
    // Fleet-wide hibernation sweeps are intentionally disabled. Wake decisions
    // use server state plus explicit daemon RPC failures instead of silently
    // demoting agents from a background probe.
  }

  return {
    alivenessCache,
    check,
    clearTransientMissingState,
    noteActivity,
    start,
  }
}
