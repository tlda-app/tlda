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
  traceId = null,
  sendDaemonDurable,
  // Bounds for the wake RPC itself. Defaulted to `null` rather than to a number
  // so this module states no policy about how long a wake may take — that
  // belongs to the caller that knows the deployment. A caller passing nothing
  // gets the old unbounded behaviour, which is a bug at the call site and
  // visible there rather than hidden behind a default here.
  rpcOptions = null,
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

  // A wake carries no mail. Skip, 14:06:12: "the demon just fucking wakes an
  // agent up. And then the server, you know, then they log in. And the server is
  // like, here are your fucking notifications."
  //
  // `notify_text`, `return_notice`, `enter_delay_ms`, `notify_delay_ms` and
  // `notify_ready_timeout_ms` were the second delivery route in payload form —
  // every one of them existed to get text typed into a pane by the daemon. The
  // return notice they uniquely carried is handed over by `login()` now, which
  // is why this could be removed without losing a behaviour.
  const wakePayload = { fleet_id: agentId }
  const spawnResult = rpcOptions
    ? await sendDaemonDurable(daemonKey, 'wake', wakePayload, rpcOptions)
    : await sendDaemonDurable(daemonKey, 'wake', wakePayload)
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
