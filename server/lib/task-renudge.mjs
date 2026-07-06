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

export function decideTaskRenudges({
  taskStates = [],
  agents = [],
  now = Date.now(),
  lastRenudged = new Map(),
  renudgeIntervalMs = DEFAULT_RENUDGE_INTERVAL_MS,
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
