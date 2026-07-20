export async function bindAgentSeat({
  ledger,
  identity,
  route,
  submit,
  readback = null,
  requireReadback = false,
  createdSource = 'agent-lifecycle-cli',
  transitionReason = null,
} = {}) {
  const agentId = identity?.agentId
  const sessionId = identity?.sessionId
  if (!agentId || !sessionId || !route?.tmuxSession) {
    throw new Error('durable seat binding requires agentId, sessionId, and tmuxSession')
  }
  const terminalCapability = ledger?.rotateTerminalCapabilitySync?.(agentId)
  if (!terminalCapability) {
    throw new Error(`durable seat binding requires daemon-minted terminal capability for ${agentId}`)
  }
  ledger?.setSessionSync?.(agentId, {
    sessionId,
    sessionKind: identity.kind,
    sessionPath: identity.sessionPath,
    tmuxSession: route.tmuxSession,
    model: identity.model,
    machineId: route.machineId,
    envName: route.envName,
    daemonKey: route.daemonKey,
    cwd: identity.cwd,
    friendlyName: identity.friendlyName,
    terminalCapability,
  })
  const payload = {
    agent_id: agentId,
    session_id: sessionId,
    resume_id: identity.resumeId || sessionId,
    kind: identity.kind,
    model: identity.model,
    cwd: identity.cwd,
    machine_id: route.machineId,
    env_name: route.envName,
    daemon_key: route.daemonKey,
    terminal_capability: terminalCapability,
    created_source: createdSource,
    ...(transitionReason ? { transition_reason: transitionReason } : {}),
  }
  let submitError = null
  try {
    await submit(payload)
    if (!requireReadback) return { bound: true, payload }
  } catch (error) {
    submitError = error
  }
  try {
    const result = await readback?.(agentId)
    const seat = result?.seat || result
    if (seat?.agent_id === agentId && seat?.session_id === sessionId && seat?.terminal_capability === terminalCapability) {
      return { bound: true, payload, seat }
    }
    const mismatch = new Error(`durable seat readback mismatch for ${agentId}/${sessionId}`)
    mismatch.terminalBindingFailure = true
    throw mismatch
  } catch (readError) {
    if (readError?.terminalBindingFailure) throw readError
    if (submitError?.status === 409 || (submitError?.status && submitError.status < 500)) {
      submitError.terminalBindingFailure = true
      throw submitError
    }
    return { bound: false, pending: true, payload, submitError, readError }
  }
}
