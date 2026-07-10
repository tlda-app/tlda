export function activityEventMessage(agentId, evt) {
  return {
    type: 'activity-event',
    agent_id: agentId,
    tool: evt.tool,
    arg: evt.arg || '',
    input: evt.input || null,
    ts: evt.ts,
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
