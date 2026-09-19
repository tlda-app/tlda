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

// Does an agent-name span cover one instant? A span with both ends null is
// UNCONDITIONAL — an id, a lineage seat, a label — and covers everything. A
// bounded span is [from_ts, to_ts), to_ts null meaning still open.
//
// A row with no timestamp is covered only by an unconditional span. That is
// the same answer TemporalMembership gives an undated event, and the same one
// SQL gives, where every comparison against a NULL timestamp is NULL and so
// not true — which is what keeps the compiled predicate and the JS evaluator
// agreeing on the same rows.
export function agentSpanCovers(span, timestamp) {
  if (!span) return false
  if (span.from_ts == null && span.to_ts == null) return true
  if (!timestamp) return false
  if (span.from_ts != null && timestamp < span.from_ts) return false
  if (span.to_ts != null && timestamp >= span.to_ts) return false
  return true
}

// True when any of `spans` names `id` at `timestamp`.
export function agentSpansCover(spans, id, timestamp) {
  if (!id) return false
  for (const span of spans || []) {
    if (span?.id === id && agentSpanCovers(span, timestamp)) return true
  }
  return false
}

// Intersect a time bound with another — `null` means unbounded, so the later
// `from` and the earlier `to` win and two absent bounds stay absent.
export function laterBound(a, b) {
  if (a == null) return b ?? null
  if (b == null) return a
  return a > b ? a : b
}

export function earlierBound(a, b) {
  if (a == null) return b ?? null
  if (b == null) return a
  return a < b ? a : b
}

// `chief & bot` names the agent that was both AT THE SAME TIME, so the spans
// intersect rather than the id sets. Intersecting ids and keeping either side's
// interval would answer with periods when only one of the two was true.
export function intersectAgentSpans(left, right) {
  const out = []
  for (const a of left || []) {
    for (const b of right || []) {
      if (!a?.id || a.id !== b?.id) continue
      const from = laterBound(a.from_ts, b.from_ts)
      const to = earlierBound(a.to_ts, b.to_ts)
      if (from != null && to != null && from >= to) continue
      out.push({ id: a.id, from_ts: from, to_ts: to })
    }
  }
  return out
}
