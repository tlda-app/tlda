export function decideTaskKicks({
  tasks = [],
  agents = [],
  now = Date.now(),
  lastKicked = new Map(),
  maxTaskAgeMs = 12 * 60 * 60 * 1000,
  quietMs = 5 * 60 * 1000,
  kickIntervalMs = 15 * 60 * 1000,
} = {}) {
  const agentById = new Map()
  for (const a of agents || []) {
    if (a?.id) agentById.set(a.id, a)
  }

  const kicks = []
  for (const task of tasks || []) {
    if (!task || task.synthetic) continue
    if (!['pending', 'working', 'idle'].includes(task.status)) continue
    const agent = agentById.get(task.agent)
    if (!agent || agent.dead || agent.human) continue
    const status = String(agent.status || '').toLowerCase()
    if (status !== 'awake' && status !== 'hibernating') continue

    const delegatedAt = Date.parse(task.delegated_at || task.created_at || '')
    if (!Number.isFinite(delegatedAt)) continue
    const taskAge = now - delegatedAt
    if (taskAge < quietMs || taskAge > maxTaskAgeMs) continue

    if (status === 'awake') {
      const lastSeen = Date.parse(agent.last_seen || agent.last_active || '')
      if (Number.isFinite(lastSeen) && now - lastSeen < quietMs) continue
    }

    const key = task.id || `${task.agent}:${task.description || ''}`
    const last = lastKicked.get(key) || 0
    if (now - last < kickIntervalMs) continue

    kicks.push({
      task,
      agent,
      key,
      taskAgeMs: taskAge,
      action: status === 'hibernating' ? 'respawn' : 'chat',
      reason: status === 'hibernating' ? 'hibernating-active-task' : 'quiet-active-task',
    })
  }
  return kicks
}

export function formatTaskKickMessage({ task, taskAgeMs, recovery = false } = {}) {
  const ageMin = Math.max(1, Math.round((taskAgeMs || 0) / 60_000))
  const description = task?.description || task?.id || 'task'
  const prefix = recovery
    ? `📬 Task recovery: you hibernated with unfinished task **${description}** (${ageMin}m old).`
    : `📬 Task check-in: you still have pending task **${description}** (${ageMin}m old).`
  return `${prefix} Call \`my_task()\`, continue the work, or report/mark it done if it is complete. Before reporting or waiting: are there loose ends you can track down yourself? Continue, set a timer, or report a true blocker with evidence.`
}
