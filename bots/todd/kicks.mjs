import { runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'

// `lastKicked` maps task key → either a bare timestamp or `{ ts }`. The
// timestamp is the bounded repeat authority: unfinished owned work remains
// eligible regardless of age and may be kicked again after the cooldown.
// `skipLive` is an optional
// Set of agent ids Skip is actively in the room with — those are suppressed
// entirely ("when I am in the room, you shut the fuck up." — Skip 6/19).
export function decideTaskKicks({
  tasks = [],
  agents = [],
  now = Date.now(),
  lastKicked = new Map(),
  quietMs = 5 * 60 * 1000,
  kickIntervalMs = 15 * 60 * 1000,
  skipLive = null,
  lastRealActivityMs = null,
  activeTimerAgents = null,
} = {}) {
  const agentById = new Map()
  for (const a of agents || []) {
    if (a?.id) agentById.set(a.id, a)
  }
  const isSkipLive = (id) => !!skipLive && typeof skipLive.has === 'function' && skipLive.has(id)
  const hasActiveTimer = (id) => !!activeTimerAgents && typeof activeTimerAgents.has === 'function' && activeTimerAgents.has(id)
  // Tolerate both the bare-timestamp shape and the current { ts } shape.
  const lastTsOf = (v) => (v && typeof v === 'object') ? (v.ts || 0) : (v || 0)

  const kicks = []
  for (const task of tasks || []) {
    if (!task || task.synthetic) continue
    if (!['pending', 'working', 'idle'].includes(task.status)) continue
    if (!task.delegated_by) continue
    const agent = agentById.get(task.agent)
    if (!agent || agent.dead || agent.human) continue
    const status = String(runtimeStatusName(agent) || '').toLowerCase()
    if (status === 'dead') continue

    // Skip-live beats the nudge — Todd doesn't manage an agent Skip is working
    // with right now. [taxonomy Cat 2: "don't listen to Todd here. We're good."]
    if (isSkipLive(agent.id)) continue
    if (hasActiveTimer(agent.id)) continue

    const delegatedAt = Date.parse(task.delegated_at || task.created_at || '')
    if (!Number.isFinite(delegatedAt)) continue
    const taskAge = now - delegatedAt
    if (taskAge < quietMs) continue

    // Guard on real work: if the agent had meaningful activity (tool calls outside
    // bot-poke suppression windows) within quietMs, they're mid-work — don't kick.
    if (lastRealActivityMs && lastRealActivityMs.has(agent.id)) {
      if (now - lastRealActivityMs.get(agent.id) < quietMs) continue
    }

    const key = task.id || `${task.agent}:${task.description || ''}`
    const prev = lastKicked.get(key)
    if (now - lastTsOf(prev) < kickIntervalMs) continue

    kicks.push({
      task,
      agent,
      key,
      taskAgeMs: taskAge,
      action: 'chat',
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
  return `${prefix} Call \`inbox()\` and interpret the task state before waiting: if responsibility remains, keep the task open and continue or assign the next action; if the responsibility is over, close it with \`report({ close: true, summary })\`. Before reporting or pausing, check for loose ends you can resolve yourself, then continue, set a timer, or report a true blocker with evidence.`
}
