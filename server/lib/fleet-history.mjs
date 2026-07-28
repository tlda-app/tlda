export const CHAT_HISTORY_EVENT_TYPES = Object.freeze([
  'chat',
  'delegate',
  'task_done',
  'terminal_user',
  'terminal_assistant',
  'timer',
  'compacting',
  'activity',
  'terminal_attention',
  'terminal_card',
  'plan_approval',
  'kill-session',
  'interrupt',
  'amend',
])

export function isChatHistoryEventType(type) {
  return CHAT_HISTORY_EVENT_TYPES.includes(type)
}

// Resolve the name held by an agent at one timestamp from the spans returned by
// FleetStore.nameSpansFor(). This is deliberately database-free so server-side
// event delivery never imports the SQLite store implementation.
export function resolveNameAt(entry, ts) {
  if (!entry) return null
  const spans = entry.spans
  if (ts && spans.length) {
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      const span = spans[i]
      if (span.from_ts <= ts && (span.to_ts == null || span.to_ts > ts)) {
        return span.friendly_name
      }
    }
    return ts < spans[0].from_ts ? spans[0].friendly_name : null
  }
  return entry.current ?? null
}
