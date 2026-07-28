export function timerSetMessage({ agentId, message, fireAt, to, repeatSeconds, expiresAt, taskId }) {
  return {
    agent: agentId,
    to: to || agentId,
    message,
    fire_at: fireAt,
    repeat_seconds: repeatSeconds,
    expires_at: expiresAt,
    task_id: taskId,
  }
}

export function timerSetEventIdFromAck(data) {
  if (data?.ok === false || data?.error) throw new Error(data.error || 'timer-set failed')
  const eventId = data?.id ?? data?.event_id ?? null
  if (eventId == null) throw new Error('timer-set failed: missing event id')
  return eventId
}
