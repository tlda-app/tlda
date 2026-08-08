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
    // One event, many recipients. A one-recipient message is an array of length
    // 1; there is no primary recipient.
    recipients: e.recipients || [],
    readBy: e.readBy || 0,
    readers: Array.isArray(e.readers) ? e.readers : [],
    recipientCount: e.recipientCount != null
      ? e.recipientCount
      : (Array.isArray(e.recipients) ? e.recipients.length : 0),
    text: e.text,
    timestamp: e.timestamp,
    read: e.read !== undefined ? e.read : false,
    _dbId: e.id,
    // Name provenance, stamped by the server against name_history at this row's
    // own timestamp. Carried through because this converter is an allowlist: a
    // field it does not name does not reach the renderer, and `chat-render`
    // reads all four. They were added in 9b18e400c and lost 17 minutes later in
    // afdb19f0c, a wholesale revert of an unrelated filtering change — after
    // which every historical line silently rendered its participants' CURRENT
    // names. `toNames`/`toNamesNow` are the per-recipient form group send
    // replaced the scalar `toName` with.
    fromName: e.fromName ?? null,
    fromNameNow: e.fromNameNow ?? null,
    toNames: Array.isArray(e.toNames) ? e.toNames : null,
    toNamesNow: Array.isArray(e.toNamesNow) ? e.toNamesNow : null,
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
    if (e.metadata?.at) msg._taskAt = e.metadata.at
    if (e.metadata?.next_fire_at) msg._taskNextFireAt = e.metadata.next_fire_at
    if (e.metadata?.repeat_seconds) msg._taskRepeatSeconds = e.metadata.repeat_seconds
    if (e.metadata?.expires_at) msg._taskExpiresAt = e.metadata.expires_at
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
    if (e.metadata?.task_id) msg._timerTaskId = e.metadata.task_id
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

export function convertChatEvents(events) {
  return (events || []).map(convertChatEvent)
}
