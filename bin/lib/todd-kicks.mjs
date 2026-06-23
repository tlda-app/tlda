// `lastKicked` maps task key → either a bare timestamp (legacy) or
// `{ ts, sig }`. `sig` is the agent/task state at the last kick; we use it to
// stop re-kicking a blocker that hasn't changed state. `skipLive` is an optional
// Set of agent ids Skip is actively in the room with — those are suppressed
// entirely ("when I am in the room, you shut the fuck up." — Skip 6/19).
export function decideTaskKicks({
  tasks = [],
  agents = [],
  now = Date.now(),
  lastKicked = new Map(),
  maxTaskAgeMs = 12 * 60 * 60 * 1000,
  quietMs = 5 * 60 * 1000,
  kickIntervalMs = 15 * 60 * 1000,
  skipLive = null,
  lastRealActivityMs = null,
} = {}) {
  const agentById = new Map()
  for (const a of agents || []) {
    if (a?.id) agentById.set(a.id, a)
  }
  const isSkipLive = (id) => !!skipLive && typeof skipLive.has === 'function' && skipLive.has(id)
  // Tolerate both the legacy bare-timestamp shape and the { ts, sig } shape.
  const lastTsOf = (v) => (v && typeof v === 'object') ? (v.ts || 0) : (v || 0)
  const lastSigOf = (v) => (v && typeof v === 'object') ? (v.sig ?? null) : null

  const kicks = []
  for (const task of tasks || []) {
    if (!task || task.synthetic) continue
    if (!['pending', 'working', 'idle'].includes(task.status)) continue
    const agent = agentById.get(task.agent)
    if (!agent || agent.dead || agent.human) continue
    const status = String(agent.status || '').toLowerCase()
    if (status === 'dead') continue

    // Skip-live beats the nudge — Todd doesn't manage an agent Skip is working
    // with right now. [taxonomy Cat 2: "don't listen to Todd here. We're good."]
    if (isSkipLive(agent.id)) continue

    const delegatedAt = Date.parse(task.delegated_at || task.created_at || '')
    if (!Number.isFinite(delegatedAt)) continue
    const taskAge = now - delegatedAt
    if (taskAge < quietMs || taskAge > maxTaskAgeMs) continue

    // Guard on real work: if the agent had meaningful activity (tool calls outside
    // bot-poke suppression windows) within quietMs, they're mid-work — don't kick.
    if (lastRealActivityMs && lastRealActivityMs.has(agent.id)) {
      if (now - lastRealActivityMs.get(agent.id) < quietMs) continue
    }

    const key = task.id || `${task.agent}:${task.description || ''}`
    const prev = lastKicked.get(key)
    if (now - lastTsOf(prev) < kickIntervalMs) continue

    // Don't re-kick a blocker that hasn't changed state since the last kick.
    // The signature is task status + the agent's status + last activity; if none
    // moved, another identical nudge carries no new information (the
    // app-project-manager case: re-kicked every 15 min for hours, "517m old",
    // with nothing new). When the agent acts or the task changes, the signature
    // changes and a kick is allowed again. [Skip 6/19]
    const realActivity = lastRealActivityMs ? (lastRealActivityMs.get(agent.id) || 0) : 0
    const sig = `${task.status}|${agent.status || ''}|${realActivity}`
    if (lastSigOf(prev) !== null && sig === lastSigOf(prev)) continue

    kicks.push({
      task,
      agent,
      key,
      sig,
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
