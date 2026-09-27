// Daemon-socket heartbeat admission. The daemon reports observed JSONL
// activity as production ({ type: 'heartbeat', agent }); the server verifies
// the claiming daemon owns the agent and records the beat — nothing else.
// Deliberately not agent-activity: a beat stamps liveness and must not wake
// the SpawnLibrarian dormant detector.
//
// Ownership mirrors never-joined-admission: the claiming daemon_key must
// equal the spawn-target key recorded at mint; rows predating that write
// fall back to the live agent-daemon route. Anything else is rejected and
// logged — fail closed, so one daemon can never hold another daemon's
// agents looking alive.
export async function admitDaemonHeartbeat(deps, msg) {
  const { store, touchActivity, log } = deps
  // Logging must never break admission: a warn sink throwing would turn a
  // rejected beat into a 500-class failure.
  const fail = (...args) => { try { log?.warn?.(...args) } catch { /* log sink is best-effort */ } }
  // The sender names `agent` (matching the agent-socket case); the daemon
  // convention is `agent_id`. One message type, both spellings.
  const agentId = (typeof msg?.agent_id === 'string' && msg.agent_id) || (typeof msg?.agent === 'string' && msg.agent) || null
  if (!agentId) {
    return { agentId: null, changed: false, ignored: 'shape' }
  }
  const claimKey = msg.daemon_key || null
  const agent = await store.getAgent?.(agentId)
  if (!agent) {
    fail(`heartbeat for unknown agent ${agentId}: ignored`)
    return { agentId, changed: false, ignored: 'unknown-agent' }
  }
  const recordedKey = agent.metadata?.spawn_daemon_key || null
  let owned = false
  if (claimKey) {
    if (recordedKey) {
      owned = claimKey === recordedKey
    } else {
      // Rollout stage, same as never-joined-admission: rows minted before
      // the spawn-key write deployed carry no key, so verify against the
      // live agent-daemon route instead. Retire by backfilling
      // spawn_daemon_key from the live route, then delete this branch.
      const route = await store.getAgentDaemonRoute?.(agent.id)
      owned = !!route && claimKey === route.daemon_key
    }
  }
  if (!owned) {
    fail(`heartbeat for ${agent.id} rejected: daemon_key mismatch`)
    return { agentId: agent.id, changed: false, ignored: 'ownership' }
  }
  touchActivity?.(agent.id)
  await store.updateHeartbeat?.(agent.id)
  return { agentId: agent.id, changed: true }
}
