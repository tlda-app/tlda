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
    if (!agent || agent.dead || agent.human || agent.status !== 'awake') continue

    const delegatedAt = Date.parse(task.delegated_at || task.created_at || '')
    if (!Number.isFinite(delegatedAt)) continue
    const taskAge = now - delegatedAt
    if (taskAge < quietMs || taskAge > maxTaskAgeMs) continue

    const lastSeen = Date.parse(agent.last_seen || agent.last_active || '')
    if (Number.isFinite(lastSeen) && now - lastSeen < quietMs) continue

    const key = task.id || `${task.agent}:${task.description || ''}`
    const last = lastKicked.get(key) || 0
    if (now - last < kickIntervalMs) continue

    kicks.push({ task, agent, key, taskAgeMs: taskAge })
  }
  return kicks
}
