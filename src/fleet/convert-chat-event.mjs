import { toolContentDetail } from './activity-render.mjs'

export function convertChatEvent(e) {
  // metadata may be a JSON string (from DB) or an object (from SSE)
  if (typeof e.metadata === 'string') {
    try { e.metadata = JSON.parse(e.metadata) } catch { e.metadata = null }
  }
  const type = e.event_type || e.type
  const msg = {
    type,
    from: e.from_id || e.from,
    to: e.to_id || e.to,
    text: e.text,
    timestamp: e.timestamp,
    read: e.read !== undefined ? e.read : false,
    _dbId: e.id,
    fromName: e.fromName || null,
    fromNameNow: e.fromNameNow || null,
    toName: e.toName || null,
    toNameNow: e.toNameNow || null,
    agentName: e.agentName || null,
    agentNameNow: e.agentNameNow || null,
    _fromLabels: Array.isArray(e.fromLabels) ? e.fromLabels : [],
    _toLabels: Array.isArray(e.toLabels) ? e.toLabels : [],
    _agentLabels: Array.isArray(e.agentLabels) ? e.agentLabels : [],
  }
  const tempId = e._tempId || e.metadata?.client_temp_id
  if (tempId) msg._tempId = tempId
  if (type === 'delegate') {
    msg._evType = 'delegate'
    msg._description = e.text || ''
    msg._taskId = e.metadata?.taskId || e.task_id || ''
    msg._fromLabel = e.metadata?.fromLabel || ''
    msg._toLabel = e.metadata?.toLabel || ''
    msg._criteria = e.metadata?.criteria || []
    if (e.metadata?.message) msg._message = e.metadata.message
  } else if (type === 'task_done') {
    msg._evType = 'task_done'
    msg._description = e.text || ''
    msg._taskId = e.metadata?.taskId || e.task_id || ''
    msg._agent = e.agent_id || e.from || ''
  } else if (type === 'terminal_attention') {
    msg._evType = 'terminal_attention'
    msg._reason = e.metadata?.reason || ''
    msg._agentLabel = e.metadata?.agentLabel || ''
    msg._snippet = e.metadata?.snippet || ''
    msg._promptResponse = e.metadata?.approvedAt ? 'approved' : e.metadata?.rejectedAt ? 'rejected' : ''
  } else if (type === 'plan_approval') {
    msg._evType = 'plan_approval'
    msg._agentId = e.metadata?.agentId || ''
    msg._agentLabel = e.metadata?.agentLabel || ''
    msg._planText = e.text || e.metadata?.planText || ''
    msg._tmuxSession = e.metadata?.tmux_session || ''
    msg._machineId = e.metadata?.machine_id || ''
    msg._planResponse = e.metadata?.rejectedAt ? 'rejected' : e.metadata?.approvedAt ? (e.metadata?.mode === 'supervised' ? 'supervised' : 'approved') : ''
  } else if (type === 'terminal_card') {
    msg._evType = 'terminal_card'
    msg._reason = e.metadata?.reason || ''
    msg._agentLabel = e.metadata?.agentLabel || ''
  } else if (type === 'terminal_user' || type === 'terminal_assistant') {
    msg._evType = type
    msg._source = e.source || 'terminal'
  } else if (type === 'timer') {
    const tmsg = e.metadata?.message || (e.text || '').replace(/^[⏱⏰]\s*/, '')
    if (e.metadata?.state === 'cancelled') {
      msg._timerCancelled = true
      msg._timerMessage = tmsg
    } else if (e.metadata?.pending) {
      msg._timerCountdown = true
      msg._timerUntil = e.metadata.fire_at
      msg._timerMessage = tmsg
      msg._timerRemaining = Math.max(0, Math.ceil((new Date(e.metadata.fire_at) - Date.now()) / 1000))
    } else if (e.metadata?.state === 'fired') {
      msg._timerFired = true
      msg._timerMessage = tmsg
    } else {
      msg._timer = true
    }
  } else if (type === 'compacting') {
    msg._compacting = true
    if (!msg.from && e.agent) msg.from = e.agent
  } else if (type === 'activity') {
    const tool = e.metadata?.tool || e.text
    msg._activity = true
    msg._activityLatency = e.metadata?.activityLatency || null
    msg._toolName = tool === '_text' ? null : (tool === '_prettyResult' ? (e.metadata?.origTool || tool) : tool)
    msg._isText = tool === '_text'
    msg._text = tool === '_text' ? (e.metadata?.arg || e.text) : null
    msg._toolArg = e.metadata?.arg || ''
    msg._toolInput = e.metadata?.input || null
    msg._toolDetail = e.metadata?.input ? toolContentDetail(tool === '_text' ? null : tool, e.metadata.input) : null
    msg._prettyResult = e.metadata?.prettyResult || null
    msg.agent = msg.from
    if (msg._isText) msg.text = e.metadata?.arg || e.text
  }
  if (e.metadata?.inline_attachments) {
    msg._inlineAttachments = e.metadata.inline_attachments
  }
  if (e.metadata?.attachments) {
    msg.attachments = e.metadata.attachments
  }
  if (e.metadata?.recipient_refs) {
    msg.metadata = { ...(msg.metadata || {}), recipient_refs: e.metadata.recipient_refs }
  }
  if (e.metadata?.source) {
    msg.metadata = { ...(msg.metadata || {}), source: e.metadata.source }
  }
  if (e.metadata?.amends != null) {
    msg.metadata = { ...(msg.metadata || {}), amends: e.metadata.amends }
  }
  if (e.metadata?.context?.bullets) {
    msg._bullets = e.metadata.context.bullets
  }
  if (e.metadata?.preambleRef) {
    msg.metadata = { ...(msg.metadata || {}), preambleRef: e.metadata.preambleRef }
  }
  return msg
}
