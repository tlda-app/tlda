export function activityEventMessage(agentId, evt) {
  const daemonSentAtMs = Date.now()
  return {
    type: 'activity-event',
    agent_id: agentId,
    tool: evt.tool,
    arg: evt.arg || '',
    input: evt.input || null,
    ts: evt.ts,
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
