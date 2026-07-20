export function shouldSkipOriginatedEvent({ eventId, originatedEventIds, isTimerFire }) {
  if (!eventId || !originatedEventIds?.has(eventId)) return false
  if (isTimerFire) return false
  originatedEventIds.delete(eventId)
  return true
}

export function shouldSuppressRecentContent({ isTimerFire, content, lastContent, lastTs, now, dedupeMs = 30000 }) {
  if (isTimerFire) return false
  return content === lastContent && now - lastTs < dedupeMs
}
