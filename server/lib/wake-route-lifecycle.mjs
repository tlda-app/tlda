import { normalizeDeliveryChannel } from '../../shared/inbox-attention.mjs'

export function terminalNudgeKind(agent) {
  const kind = agent?.metadata?.kind || agent?.kind
  return kind === 'codex' || kind === 'goose'
}

export function deliveryChannelFor(agent) {
  return normalizeDeliveryChannel(agent?.metadata?.deliveryChannel)
}

export function shouldSendWakeNudge(agent, nudgeText) {
  if (!nudgeText) return false
  return deliveryChannelFor(agent) === 'tmux' || terminalNudgeKind(agent)
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
  seat = null,
  daemonKey,
  ownerDaemon,
  nudgeText = null,
  traceId = null,
  source = {},
  isAgentAwake,
  sendDaemonDurable,
  sendDaemonEphemeral,
  spawnLibrarian,
  appendControlTrace = () => {},
  sendWakeNudge,
  getCurrentSeat,
  queueRetry = () => {},
  broadcastEvent = () => {},
  insertWakeLifecycleEvent = async () => {},
  recordRuntimeLiveness = () => {},
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

  if (!seat?.terminal_capability) throw new Error(`agent ${agent.friendly_name || agentId} has no current durable terminal capability; cannot route wake/respawn`)
  if (!ownerDaemon || ownerDaemon.readyState !== 1) throw new Error(`No fleet-daemon connected for ${daemonKey}`)

  // The agent row, not an id: this used to hand an id to a function that went
  // and re-read the seat that is already checked two lines above.
  const serverAlive = isAgentAwake(agent)
  const liveness = await sendDaemonDurable(daemonKey, 'check-alive', { agent_id: agentId, terminal_capability: seat.terminal_capability })
    .then(result => livenessFromCheckAliveResult(agentId, result))
    .catch(e => ({
      type: 'agent-liveness',
      agent_id: agentId,
      state: 'unknown',
      reason: e.message,
      ts: new Date().toISOString(),
    }))
  spawnLibrarian.observeLiveness({ ...liveness, agent_id: liveness.agent_id || agentId })
  recordRuntimeLiveness({ ...liveness, agent_id: liveness.agent_id || agentId })

  const decision = spawnLibrarian.decideWake(agent, { ...liveness, agent_id: liveness.agent_id || agentId }, { serverAlive: serverAlive || liveness.state === 'alive' })
  if (traceId) {
    appendControlTrace({
      trace_id: traceId,
      component: 'server',
      operation: 'wake.decision',
      status: decision.action,
      detail: { agent: agentId, liveness: liveness.state },
    })
  }

  if (decision.action === 'deliver') {
    if (traceId) {
      appendControlTrace({
        trace_id: traceId,
        component: 'server',
        operation: 'wake.noop',
        status: 'already-awake',
        detail: { agent: agentId },
      })
    }
    return { action: 'already-awake', liveness, decision }
  }

  if (decision.action === 'queue') {
    queueRetry()
    return { action: 'queued', liveness, decision }
  }
  if (decision.action === 'hold') return { action: 'held', liveness, decision }
  if (decision.action === 'surface') {
    broadcastEvent('agent-wedged', { agentId, reason: decision.message, ts: new Date().toISOString() })
    return { action: 'surfaced', liveness, decision }
  }

  const spawnResult = await sendDaemonDurable(daemonKey, 'wake', { fleet_id: agentId })
  if (!spawnResult?.ok) {
    throw new Error(spawnResult?.error || spawnResult?.reason || 'daemon returned ok:false with no reason')
  }
  const nextSeat = await getCurrentSeat?.(agentId)
  if (!nextSeat?.daemon_key || !nextSeat?.terminal_capability || !nextSeat?.session_id) {
    throw new Error(`respawn for ${agentId} did not establish a current durable binding`)
  }
  await sendWakeNudge(
    nextSeat.daemon_key,
    agent,
    nextSeat,
    nudgeText,
    'post-respawn',
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
  return { action: 'respawned', liveness, decision, spawnResult }
}
