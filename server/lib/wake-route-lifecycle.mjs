export function livenessFromCheckAliveResult(agentId, result) {
  if (result?.state) return { ...result, agent_id: result.agent_id || agentId }
  if (typeof result?.alive === 'boolean') {
    return {
      type: 'agent-liveness',
      agent_id: agentId,
      state: result.alive ? 'alive' : 'dead',
      reason: result.alive ? undefined : 'daemon check-alive: terminal capability unavailable',
      ts: new Date().toISOString(),
    }
  }
  return {
    type: 'agent-liveness',
    agent_id: agentId,
    state: 'unknown',
    reason: 'daemon check-alive returned no liveness state',
    ts: new Date().toISOString(),
  }
}

export async function runWakeRouteLifecycle({
  agentId,
  agent,
  daemonKey,
  ownerDaemon,
  nudgeText = null,
  returnNoticeText = null,
  enterDelayMs = 0,
  traceId = null,
  sendDaemonDurable,
  appendControlTrace = () => {},
  getAgentDaemonRoute,
  insertWakeLifecycleEvent = async () => {},
}) {
  if (traceId) {
    appendControlTrace({
      trace_id: traceId,
      component: 'server',
      operation: 'wake.route',
      status: 'started',
      detail: { agent: agentId, daemon: daemonKey },
    })
  }

  if (!ownerDaemon || ownerDaemon.readyState !== 1) throw new Error(`No fleet-daemon connected for ${daemonKey}`)

  const wakePayload = { fleet_id: agentId }
  if (nudgeText) {
    wakePayload.notify_text = nudgeText
    if (returnNoticeText) wakePayload.return_notice = returnNoticeText
    if (enterDelayMs != null) wakePayload.enter_delay_ms = enterDelayMs
  } else if (returnNoticeText) {
    wakePayload.notify_text = returnNoticeText
    if (enterDelayMs != null) wakePayload.enter_delay_ms = enterDelayMs
  }
  const spawnResult = await sendDaemonDurable(daemonKey, 'wake', wakePayload)
  if (!spawnResult?.ok) {
    throw new Error(spawnResult?.error || spawnResult?.reason || 'daemon returned ok:false with no reason')
  }
  const nextSeat = await getAgentDaemonRoute?.(agentId)
  if (!nextSeat?.daemon_key) throw new Error(`wake for ${agentId} did not retain a daemon route`)
  if (traceId) {
    appendControlTrace({
      trace_id: traceId,
      component: 'server',
      operation: 'wake.respawn',
      status: 'sent',
      detail: { agent: agentId, daemon: nextSeat.daemon_key },
    })
  }
  await insertWakeLifecycleEvent({ agentId })
  return { action: spawnResult.alreadyAlive ? 'already-awake' : 'respawned', spawnResult }
}
