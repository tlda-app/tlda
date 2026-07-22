export function recordAgentBindingEvent(fleetStore, msg = {}, {
  machineId = null,
  envName = null,
  daemonKey = null,
} = {}) {
  if (!fleetStore) throw new Error('fleet store is required')
  const agentId = msg.agent_id || msg.agentId
  const sessionId = msg.session_id || msg.sessionId
  const route = {
    machineId: msg.machine_id || machineId,
    envName: msg.env_name || envName,
    daemonKey: msg.daemon_key || daemonKey,
    terminalCapability: msg.terminal_capability || msg.terminalCapability,
  }
  if (!agentId) throw new Error('agent-binding event missing agent_id')

  if (sessionId) {
    fleetStore.insertAgentSeat({
      agent_id: agentId,
      session_id: sessionId,
      resume_id: msg.resume_id || msg.resumeId || sessionId,
      kind: msg.kind,
      model: msg.model,
      cwd: msg.cwd,
      created_source: msg.created_source || 'daemon-runtime',
      created_by_event_id: msg.created_by_event_id || null,
    })
  }
  const seat = fleetStore.activateAgentSeat({
    agentId,
    sessionId,
    ...route,
    reason: msg.transition_reason || 'runtime-binding',
    activatedByEventId: msg.activated_by_event_id || null,
  })
  fleetStore.mirrorAgentSeatIdentity?.({
    agentId,
    session_id: seat.session_id,
    session_ids: seat.session_id ? [seat.session_id] : null,
    resume_id: seat.resume_id || seat.session_id,
    cwd: seat.cwd || msg.cwd || null,
    machine_id: seat.machine_id,
    env_name: seat.env_name,
    daemon_key: seat.daemon_key,
  })
  return seat
}
