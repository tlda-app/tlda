export function shouldSendWakeNudge(agent, nudgeText) {
  return Boolean(nudgeText)
}

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
  traceId = null,
  sendDaemonDurable,
  appendControlTrace = () => {},
  sendWakeNudge,
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

  const spawnResult = await sendDaemonDurable(daemonKey, 'wake', { fleet_id: agentId })
  if (!spawnResult?.ok) {
    throw new Error(spawnResult?.error || spawnResult?.reason || 'daemon returned ok:false with no reason')
  }
  const nextSeat = await getAgentDaemonRoute?.(agentId)
  if (!nextSeat?.daemon_key) throw new Error(`wake for ${agentId} did not retain a daemon route`)
  const deliveredNudge = spawnResult.already
    ? nudgeText
    : (returnNoticeText || nudgeText)
  await sendWakeNudge(
    nextSeat.daemon_key,
    agent,
    deliveredNudge,
    spawnResult.already ? 'already-awake' : 'post-respawn',
    'wake-route',
  )
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
  return { action: spawnResult.already ? 'already-awake' : 'respawned', spawnResult }
}
