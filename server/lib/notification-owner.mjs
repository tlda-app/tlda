export function notificationOwnerKey(agentId, sessionId) {
  return `${agentId}\0${sessionId}`
}

export function notificationClaimMatches(claim, startedAt, instanceId) {
  return !!claim
    && Number(claim.started_at) === Number(startedAt)
    && claim.instance_id === instanceId
}

export function notificationRecipients(msg) {
  const event = msg?.event
  const data = msg?.data
  const eventType = data?.type
  const isDirect = event === 'fleet-event'
    && ['chat', 'delegate', 'task_done', 'timer'].includes(eventType)
  const isTimerFire = event === 'event-update'
    && eventType === 'timer'
    && data?.metadata?.state === 'fired'
  if (!isDirect && !isTimerFire) return null
  const recipients = new Set()
  const direct = data?.to || data?.to_id
  if (direct) recipients.add(direct)
  for (const recipient of data?.metadata?.wiretap_cc || []) recipients.add(recipient)
  return recipients
}

export async function readNotificationFlushIfOwner({
  registry,
  ws,
  agentId,
  sessionId,
  startedAt,
  instanceId,
  read,
  empty,
}) {
  if (!registry.isOwner(ws, agentId, sessionId, startedAt, instanceId)) return empty
  const response = await read()
  return registry.isOwner(ws, agentId, sessionId, startedAt, instanceId) ? response : empty
}

export class NotificationOwnerRegistry {
  constructor(store) {
    this.store = store
    this.sockets = new Map()
    this.agentSessionKeys = new Map()
  }

  async bind(ws, agentId, sessionId) {
    if (!ws?._notificationSubscriber) return false
    const startedAt = Number(ws._notificationStartedAt)
    const instanceId = ws._notificationInstanceId
    if (!sessionId || !instanceId || !Number.isSafeInteger(startedAt) || startedAt < 0) return false
    if (ws._notificationSessionId !== sessionId) return false
    const seat = await this.store.getCurrentAgentSeat?.(agentId)
    if (!seat || seat.session_id !== sessionId) return false
    const claim = await this.store.claimNotificationOwner({ agentId, sessionId, startedAt, instanceId })
    if (!notificationClaimMatches(claim, startedAt, instanceId)) return false
    ws._notificationAgentId = agentId
    ws._notificationOwner = true
    const key = notificationOwnerKey(agentId, sessionId)
    this.sockets.set(key, ws)
    this.agentSessionKeys.set(agentId, key)
    return true
  }

  clear(ws) {
    if (!ws?._notificationAgentId || !ws?._notificationSessionId) return
    const key = notificationOwnerKey(ws._notificationAgentId, ws._notificationSessionId)
    if (this.sockets.get(key) === ws) this.sockets.delete(key)
    ws._notificationOwner = false
  }

  isOwner(ws, agentId, sessionId, startedAt, instanceId) {
    if (!ws?._notificationSubscriber || !agentId || !sessionId) return false
    if (ws._notificationAgentId !== agentId || ws._notificationSessionId !== sessionId) return false
    if (Number(ws._notificationStartedAt) !== Number(startedAt) || ws._notificationInstanceId !== instanceId) return false
    return this.sockets.get(notificationOwnerKey(agentId, sessionId)) === ws
  }

  socketFor(agentId) {
    const key = this.agentSessionKeys.get(agentId)
    if (!key) return null
    const ws = this.sockets.get(key)
    if (!ws || ws.readyState !== 1) return null
    return ws
  }
}
