export async function agentsForTerminalWatchResume({
  watchedAgentIds = [],
  getAgentsByIds = () => [],
  getCurrentAgentSeat = () => null,
  daemonKey,
} = {}) {
  if (!daemonKey) return []
  const watched = new Set((watchedAgentIds || []).filter(Boolean).map(String))
  if (!watched.size) return []
  const agents = await getAgentsByIds([...watched]) || []
  const out = []
  for (const agent of agents) {
    if (!agent?.id || !watched.has(agent.id)) continue
    const seat = await getCurrentAgentSeat(agent.id)
    if (!seat || seat.daemon_key !== daemonKey || !seat.terminal_capability) continue
    out.push({ agent, seat })
  }
  return out
}
