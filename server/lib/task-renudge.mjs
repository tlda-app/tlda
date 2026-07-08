const DEFAULT_RENUDGE_INTERVAL_MS = 5 * 60 * 1000

function timeOf(value) {
  const ts = Date.parse(value || '')
  return Number.isFinite(ts) ? ts : 0
}

function lastTsOf(value) {
  if (value && typeof value === 'object') return value.ts || 0
  return value || 0
}

export function taskRenudgeKey(task, event) {
  return String(event?.id || task?.id || `${task?.agent || 'unknown'}:${task?.description || ''}`)
}

export function isRenudgeableTaskStatus(status) {
  return ['pending', 'working', 'idle'].includes(String(status || '').toLowerCase())
}

// A per-agent wake circuit breaker (state owned by unified-server): open while
// `nextTs` is in the future, i.e. an agent whose consecutive wake failures put it
// in exponential backoff. Exported so the renudge decision stays pure/testable.
export function isWakeBreakerOpen(breaker, agentId, now) {
  const b = breaker?.get?.(agentId)
  return !!(b && b.nextTs > now)
}

// Exponential backoff for the wake breaker: after `fails` consecutive failures,
// wait base * 2**(fails-1), capped. E.g. base=5m → 5,10,20,40,80,120(cap) min.
export function wakeBreakerBackoffMs(fails, baseMs, capMs) {
  return Math.min(baseMs * 2 ** (Math.max(1, fails) - 1), capMs)
}

export function decideTaskRenudges({
  taskStates = [],
  agents = [],
  now = Date.now(),
  lastRenudged = new Map(),
  renudgeIntervalMs = DEFAULT_RENUDGE_INTERVAL_MS,
  wakeBreaker = null,
} = {}) {
  const agentById = new Map()
  for (const agent of agents || []) {
    if (agent?.id) agentById.set(agent.id, agent)
  }

  const nudges = []
  for (const state of taskStates || []) {
    const task = state?.task
    const event = state?.event
    if (!task || task.synthetic) continue
    if (!isRenudgeableTaskStatus(task.status)) continue
    if (task.blockedBy?.length || task.metadata?.deferred || task.metadata?.retracted) continue
    if (!event || event.type !== 'delegate') continue
    if (!state.unreadPending) continue

    const agent = agentById.get(task.agent)
    if (!agent || agent.dead || agent.human) continue
    const status = String(agent.status || '').toLowerCase()
    if (status === 'dead' || status === 'shell') continue
    // Skip agents whose wake breaker is open (consecutive wake failures →
    // exponential backoff). Prevents the endless futile respawns of agents whose
    // session can't be resolved. Reset on recovery (register / successful wake).
    if (isWakeBreakerOpen(wakeBreaker, task.agent, now)) continue

    const delegatedAt = timeOf(task.delegated_at || event.timestamp)
    if (!delegatedAt || now < delegatedAt) continue

    const key = taskRenudgeKey(task, event)
    if (now - lastTsOf(lastRenudged.get(key)) < renudgeIntervalMs) continue

    nudges.push({
      key,
      task,
      event,
      agent,
      taskAgeMs: now - delegatedAt,
      reason: status === 'hibernating' ? 'hibernating-unread-task' : 'unread-task-delivery-due',
    })
  }
  return nudges
}
