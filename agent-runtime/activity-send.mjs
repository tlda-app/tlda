export function activityEventMessage(agentId, evt) {
  const daemonSentAtMs = Date.now()
  const daemonReceivedAtMs = evt.daemonReceivedAtMs == null || evt.daemonReceivedAtMs === ''
    ? null
    : Number(evt.daemonReceivedAtMs)
  const finiteDaemonReceivedAtMs = Number.isFinite(daemonReceivedAtMs) ? daemonReceivedAtMs : null
  return {
    type: 'activity-event',
    agent_id: agentId,
    tool: evt.tool,
    arg: evt.arg || '',
    input: evt.input || null,
    ts: evt.ts,
    daemon_received_at: evt.daemonReceivedAt || (finiteDaemonReceivedAtMs != null ? new Date(finiteDaemonReceivedAtMs).toISOString() : null),
    daemon_received_at_ms: finiteDaemonReceivedAtMs,
    daemon_sent_at: new Date(daemonSentAtMs).toISOString(),
    daemon_sent_at_ms: daemonSentAtMs,
    ...(evt.usage ? { usage: evt.usage } : {}),
    ...(evt.prettyResult ? { prettyResult: evt.prettyResult } : {}),
    ...(evt.origTool ? { origTool: evt.origTool } : {}),
  }
}

export function sendActivityEvents(agentId, evts, sendMsg) {
  for (const evt of evts) {
    if (!sendMsg(activityEventMessage(agentId, evt))) return false
  }
  return true
}
