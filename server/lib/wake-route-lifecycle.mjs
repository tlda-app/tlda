import { normalizeDeliveryChannel } from '../../shared/inbox-attention.mjs'

export function terminalNudgeKind(agent) {
  const kind = agent?.metadata?.kind || agent?.kind
  return kind === 'codex' || kind === 'goose'
}

export function deliveryChannelFor(agent) {
  return normalizeDeliveryChannel(agent?.metadata?.deliveryChannel)
}

export function shouldSendWakeNudge(agent, nudgeText) {
  if (!nudgeText || !agent?.tmux_session) return false
  return deliveryChannelFor(agent) === 'tmux' || terminalNudgeKind(agent)
}

export function livenessFromCheckAliveResult(agentId, tmuxSession, result) {
  if (result?.state) return { ...result, agent_id: result.agent_id || agentId, tmux_session: result.tmux_session || tmuxSession }
  if (typeof result?.alive === 'boolean') {
    return {
      type: 'agent-liveness',
      agent_id: agentId,
      tmux_session: tmuxSession,
      state: result.alive ? 'alive' : 'dead',
      reason: result.alive ? undefined : 'daemon check-alive: tmux session absent',
      ts: new Date().toISOString(),
    }
  }
  return {
    type: 'agent-liveness',
    agent_id: agentId,
    tmux_session: tmuxSession,
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
  asker = null,
  traceId = null,
  source = {},
  isAgentAlive,
  sendRpcResilient,
  sendRpc,
  spawnLibrarian,
  recordWakeAttempt,
  appendControlTrace = () => {},
  sendWakeNudge,
  getCurrentSeat,
  awaitWakeAcknowledgment = () => {},
  queueRetry = () => {},
  broadcastEvent = () => {},
  insertWakeLifecycleEvent = async () => {},
}) {
  if (traceId) {
    await recordWakeAttempt({ agentId, traceId, ...source, outcome: 'attempted', reason: 'daemon-route-selected', evidence: { daemon: daemonKey } })
    appendControlTrace({
      trace_id: traceId,
      component: 'server',
      operation: 'wake.route',
      status: 'started',
      detail: { agent: agentId, daemon: daemonKey },
    })
  }

  if (!seat?.daemon_key || !seat?.tmux_session) throw new Error(`agent ${agent.friendly_name || agentId} has no current durable seat; cannot route wake/respawn`)
  if (!ownerDaemon || ownerDaemon.readyState !== 1) throw new Error(`No fleet-daemon connected for ${daemonKey}`)

  const serverAlive = isAgentAlive(agentId)
  const liveness = serverAlive
    ? await sendRpcResilient(daemonKey, 'check-alive', { agent_id: agentId, session_id: seat.session_id, tmux_session: seat.tmux_session })
      .then(result => livenessFromCheckAliveResult(agentId, seat.tmux_session, result))
      .catch(e => ({
        type: 'agent-liveness',
        agent_id: agentId,
        tmux_session: seat.tmux_session,
        state: 'unknown',
        reason: e.message,
        ts: new Date().toISOString(),
      }))
    : {
        type: 'agent-liveness',
        agent_id: agentId,
        tmux_session: seat.tmux_session,
        state: 'unknown',
        reason: 'server liveness says hibernating',
        ts: new Date().toISOString(),
      }
  spawnLibrarian.observeLiveness({ ...liveness, agent_id: liveness.agent_id || agentId })
  if (traceId) {
    await recordWakeAttempt({
      agentId,
      traceId,
      ...source,
      outcome: liveness.state === 'unknown' ? 'deferred' : 'attempted',
      reason: 'check-alive',
      nextAction: liveness.state === 'unknown' ? 'classify-liveness' : 'none',
      evidence: { liveness: liveness.state, livenessReason: liveness.reason || null },
    })
  }

  const decision = spawnLibrarian.decideWake(agent, { ...liveness, agent_id: liveness.agent_id || agentId }, { serverAlive })
  if (traceId) {
    await recordWakeAttempt({
      agentId,
      traceId,
      ...source,
      outcome: decision.action === 'hold' || decision.action === 'queue' ? 'deferred' : 'attempted',
      reason: `spawn-librarian:${decision.action}`,
      nextAction: decision.action === 'queue' ? 'retry' : decision.action === 'hold' ? 'escalate' : 'none',
      evidence: { liveness: liveness.state },
    })
    appendControlTrace({
      trace_id: traceId,
      component: 'server',
      operation: 'wake.decision',
      status: decision.action,
      detail: { agent: agentId, liveness: liveness.state },
    })
  }

  if (decision.action === 'deliver') {
    await sendWakeNudge(daemonKey, agent, seat.tmux_session, nudgeText, 'deliver', 'wake-route', seat.session_id)
    if (traceId) {
      await recordWakeAttempt({ agentId, traceId, ...source, outcome: 'delivered', reason: 'send-text-ok', evidence: { daemon: daemonKey, phase: 'deliver' } })
      awaitWakeAcknowledgment({ agentId, traceId, source, asker })
      appendControlTrace({
        trace_id: traceId,
        component: 'server',
        operation: 'wake.nudge',
        status: 'sent',
        detail: { agent: agentId, mode: 'deliver' },
      })
    }
    return { action: 'delivered', liveness, decision }
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

  const spawnResult = await sendRpc(daemonKey, 'spawn', { name: agentId, agent_id: agentId, respawn: true })
  if (!spawnResult?.ok) {
    throw new Error(spawnResult?.error || spawnResult?.reason || 'daemon returned ok:false with no reason')
  }
  const nextSeat = getCurrentSeat?.(agentId)
  if (!nextSeat?.daemon_key || !nextSeat?.tmux_session || !nextSeat?.session_id) {
    throw new Error(`respawn for ${agentId} did not establish a current durable binding`)
  }
  await sendWakeNudge(
    nextSeat.daemon_key,
    agent,
    nextSeat.tmux_session,
    nudgeText,
    'post-respawn',
    'wake-route',
    nextSeat.session_id,
  )
  if (traceId) {
    await recordWakeAttempt({ agentId, traceId, ...source, outcome: 'delivered', reason: 'spawn-and-send-text-ok', evidence: { daemon: nextSeat.daemon_key, phase: 'respawn' } })
    awaitWakeAcknowledgment({ agentId, traceId, source, asker })
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
