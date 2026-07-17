import { decideTaskKicks } from './kicks.mjs'
import { runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'

const DEFAULT_LOOKBACK_MS = 15 * 60_000
const DEFAULT_RECENT_MS = 5 * 60_000
const DEFAULT_QUIET_MS = 5 * 60_000
const DEFAULT_KICK_INTERVAL_MS = 15 * 60_000
const DEFAULT_MAX_TASK_AGE_MS = 2 * 60 * 60_000
const OWNER_ID = 'fleet:skip'

const ACTIVITY_TYPES = new Set(['activity', 'chat', 'report', 'task_done', 'turn_ended', 'timer', 'notification_attempt'])
const PROGRESS_TYPES = new Set(['report', 'task_done'])

export function parseFleetActivityCommand(text, { verb = 'todd', direct = false } = {}) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  const verbRe = escapeRegExp(verb)
  const directRe = direct
    ? /(?:^|\b)(?:activity|graph|is\s+the\s+fleet\s+moving)\b/i
    : new RegExp(`\\b${verbRe}\\b[\\s,.:;-]*(?:activity|graph|is\\s+the\\s+fleet\\s+moving)\\b`, 'i')
  if (!directRe.test(raw)) return null
  return {
    mode: /\b(?:detail|operator|--detail|-v)\b/i.test(lower) ? 'operator' : 'skip',
  }
}

export function buildFleetActivityReport({
  now = Date.now(),
  agents = [],
  tasks = [],
  events = [],
  telemetryStatus = null,
  rosterTruth = null,
  mode = 'skip',
  toddConfig = {},
} = {}) {
  const config = {
    lookbackMs: toddConfig.lookbackMs || DEFAULT_LOOKBACK_MS,
    recentMs: toddConfig.recentMs || DEFAULT_RECENT_MS,
    quietMs: toddConfig.quietMs || DEFAULT_QUIET_MS,
    kickIntervalMs: toddConfig.kickIntervalMs || DEFAULT_KICK_INTERVAL_MS,
    maxTaskAgeMs: toddConfig.maxTaskAgeMs || DEFAULT_MAX_TASK_AGE_MS,
    lastKicked: toddConfig.lastKicked || new Map(),
    lastRealActivityMs: toddConfig.lastRealActivityMs || null,
    skipLive: toddConfig.skipLive || null,
  }
  const sinceMs = now - config.lookbackMs
  const recentCutoff = now - config.recentMs
  const normalizedAgents = normalizeAgents(agents)
  const normalizedTasks = normalizeTasks(tasks)
  const normalizedEvents = normalizeEvents(events, sinceMs)
  const agentById = new Map(normalizedAgents.map(agent => [agent.id, agent]))
  const activeTasks = normalizedTasks.filter(isActiveTask)

  const activity = activityByAgent(normalizedEvents, now, config)
  const activeTimerAgents = activeTimerAgentSet(normalizedEvents, normalizedAgents, now)
  const skipLive = mergeSets(config.skipLive, skipLiveAgentSet(normalizedEvents, now, config.recentMs))
  const lastRealActivityMs = mergeActivityMaps(config.lastRealActivityMs, activity.lastRealActivityMs)
  const kicks = decideTaskKicks({
    tasks: activeTasks,
    agents: normalizedAgents,
    now,
    lastKicked: config.lastKicked,
    maxTaskAgeMs: config.maxTaskAgeMs,
    quietMs: config.quietMs,
    kickIntervalMs: config.kickIntervalMs,
    skipLive,
    lastRealActivityMs,
    activeTimerAgents,
  })
  const kickByAgent = new Map(kicks.map(kick => [kick.agent.id, kick]))
  const telemetryItems = telemetryAttentionItems(telemetryStatus)
  const rosterRoute = rosterRouteEvidence(rosterTruth)

  const rows = []
  for (const task of activeTasks) {
    const agent = agentById.get(task.agent) || { id: task.agent, runtime_status: { status: 'unknown' } }
    const agentStatus = String(runtimeStatusName(agent) || 'unknown').toLowerCase()
    const stats = activity.byAgent.get(task.agent) || emptyActivityStats()
    const kick = kickByAgent.get(task.agent)
    const waiting = taskLooksWaiting(task) || activeTimerAgents.has(task.agent)
    const noRoute = !hasRouteEvidence(agent, rosterRoute)
    const deadish = agent.dead || ['dead', 'hibernating'].includes(agentStatus)
    let state = 'quiet'
    let todd = 'no kick'
    let reason = ''

    if (deadish && noRoute) {
      state = 'needsHuman'
      reason = 'no route evidence'
      todd = 'needs human'
    } else if (kick) {
      state = 'toddWillKick'
      todd = kick.action === 'respawn' ? 'respawn next sweep' : 'kick next sweep'
      reason = kick.reason || 'quiet-active-task'
    } else if (waiting) {
      state = 'waiting'
      reason = activeTimerAgents.has(task.agent) ? 'timer active' : 'waiting/blocked'
    } else if (stats.lastProgressMs >= recentCutoff || stats.lastActivityMs >= recentCutoff) {
      state = 'moving'
      reason = stats.lastProgressMs >= recentCutoff ? 'recent progress' : 'recent activity'
    } else if (agentStatus !== 'awake') {
      state = 'quiet'
      reason = agentStatus
    }

    rows.push({
      agent,
      task,
      stats,
      state,
      todd,
      reason,
      taskAgeMs: taskAgeMs(task, now),
      lastWorkMs: stats.lastAnyMs || parseTime(agent.last_seen),
    })
  }

  for (const [agentId, stats] of activity.byAgent) {
    if (rows.some(row => row.agent.id === agentId)) continue
    if (stats.lastProgressMs >= recentCutoff || stats.lastActivityMs >= recentCutoff) {
      const agent = agentById.get(agentId) || { id: agentId, runtime_status: { status: 'unknown' } }
      rows.push({
        agent,
        task: null,
        stats,
        state: 'moving',
        todd: 'no kick',
        reason: stats.lastProgressMs >= recentCutoff ? 'recent progress' : 'recent activity',
        taskAgeMs: null,
        lastWorkMs: stats.lastAnyMs,
      })
    }
  }

  const needsHumanItems = []
  for (const row of rows) {
    if (row.state === 'needsHuman') needsHumanItems.push(row)
  }
  for (const item of telemetryItems) {
    needsHumanItems.push({ telemetry: item, state: 'needsHuman' })
  }

  const counts = {
    moving: rows.filter(row => row.state === 'moving').length,
    quiet: rows.filter(row => row.state === 'quiet').length,
    waiting: rows.filter(row => row.state === 'waiting').length,
    toddWillKick: rows.filter(row => row.state === 'toddWillKick').length,
    needsHuman: needsHumanItems.length,
  }
  const status = chooseStatus(counts)
  const sourceCounts = {
    agents: normalizedAgents.length,
    tasks: normalizedTasks.length,
    activeTasks: activeTasks.length,
    events: normalizedEvents.length,
    telemetryAttention: telemetryItems.length,
  }
  const evidence = {
    sourceCounts,
    windows: {
      lookbackMs: config.lookbackMs,
      recentMs: config.recentMs,
      quietMs: config.quietMs,
    },
    omitted: {
      exactToddNextKickTime: true,
    },
  }
  const detailMarkdown = renderOperatorMarkdown({
    status,
    counts,
    rows,
    events: normalizedEvents,
    telemetryItems,
    sourceCounts,
    now,
  })
  const markdown = mode === 'operator'
    ? detailMarkdown
    : renderSkipMarkdown({ status, counts, rows, events: normalizedEvents, telemetryItems, sourceCounts, now })

  return {
    status,
    counts,
    markdown,
    detailMarkdown,
    evidence,
  }
}

function renderSkipMarkdown({ status, counts, rows, events, telemetryItems, sourceCounts, now }) {
  const progressCount = events.filter(event => PROGRESS_TYPES.has(event.type)).length
  const activityCount = events.filter(event => event.type === 'activity' || event.type === 'turn_ended').length
  const lines = [
    `Fleet activity: ${statusLabel(status)}`,
    '',
    `Last 15 min: ${activityCount} activity/turn events, ${progressCount} progress updates, ${sourceCounts.activeTasks} active tasks`,
    '',
    countBar('moving', counts.moving),
    countBar('quiet', counts.quiet),
    countBar('waiting', counts.waiting),
    countBar('Todd kick', counts.toddWillKick),
    countBar('needs you', counts.needsHuman),
    '',
    toddLine(counts.toddWillKick),
    actionLine(status, counts.needsHuman),
  ]
  const quiet = rows.filter(row => row.state === 'quiet' || row.state === 'toddWillKick' || row.state === 'needsHuman').slice(0, 3)
  if (quiet.length) {
    lines.push('', 'Watch:')
    for (const row of quiet) {
      lines.push(`- ${displayAgent(row.agent)}: ${shortState(row.state)}; last work ${formatAgeFrom(row.lastWorkMs, now)}; task ${formatDuration(row.taskAgeMs)} old`)
    }
  }
  if (telemetryItems.length) {
    lines.push('', `Telemetry: ${telemetryItems.slice(0, 2).map(item => item.label).join('; ')}`)
  }
  return lines.join('\n')
}

function renderOperatorMarkdown({ status, counts, rows, events, telemetryItems, sourceCounts, now }) {
  const lines = [
    `Fleet activity: ${statusLabel(status)} (operator detail)`,
    '',
    `Sources: ${sourceCounts.agents} agents, ${sourceCounts.activeTasks}/${sourceCounts.tasks} active tasks, ${sourceCounts.events} recent events`,
    '',
    '| agent | id | state | task age | last work | Todd |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  const sorted = [...rows].sort((a, b) => stateRank(a.state) - stateRank(b.state) || ((b.lastWorkMs || 0) - (a.lastWorkMs || 0)))
  for (const row of sorted.slice(0, 12)) {
    lines.push(`| ${escapeCell(displayAgent(row.agent))} | ${escapeCell(row.agent.id || '')} | ${shortState(row.state)} | ${formatDuration(row.taskAgeMs)} | ${formatAgeFrom(row.lastWorkMs, now)} | ${escapeCell(row.todd)} |`)
  }
  const completions = events.filter(event => PROGRESS_TYPES.has(event.type)).slice(-5).reverse()
  if (completions.length) {
    lines.push('', 'Recent completions/reports:')
    for (const event of completions) lines.push(`- ${event.type} from ${event.from || event.agent_id || 'unknown'} ${formatAgeFrom(event.ts, now)}`)
  }
  const quiet = sorted.filter(row => row.state === 'quiet' || row.state === 'toddWillKick').slice(0, 5)
  if (quiet.length) {
    lines.push('', 'Quiet active tasks:')
    for (const row of quiet) lines.push(`- ${displayAgent(row.agent)} (${row.agent.id}): ${row.task?.description || row.task?.id || 'active task'}; ${row.todd}`)
  }
  const needs = sorted.filter(row => row.state === 'needsHuman').slice(0, 5)
  if (needs.length || telemetryItems.length) {
    lines.push('', 'Needs human:')
    for (const row of needs) lines.push(`- ${displayAgent(row.agent)} (${row.agent.id}): ${row.reason || 'needs route/action'}`)
    for (const item of telemetryItems.slice(0, 5)) lines.push(`- telemetry: ${item.label}`)
  }
  lines.push('', countBar('moving', counts.moving), countBar('quiet', counts.quiet), countBar('waiting', counts.waiting), countBar('Todd kick', counts.toddWillKick), countBar('needs human', counts.needsHuman))
  return lines.join('\n')
}

function normalizeAgents(input) {
  const list = Array.isArray(input) ? input : (input?.agents || [])
  return list.filter(agent => agent && (agent.id || agent.agent_id)).map(agent => ({
    ...agent,
    id: agent.id || agent.agent_id,
    friendly_name: agent.friendly_name || agent.name || agent.lineage_name || null,
    status: runtimeStatusName(agent) || (agent.dead ? 'dead' : 'unknown'),
    last_seen: agent.last_seen || agent.lastSeen || agent.lastSeenAt || null,
  }))
}

function normalizeTasks(input) {
  const list = Array.isArray(input) ? input : (input?.tasks || [])
  return list.filter(task => task && (task.agent || task.agent_id)).map(task => ({
    ...task,
    agent: task.agent || task.agent_id,
    status: task.status || 'pending',
  }))
}

function normalizeEvents(input, sinceMs) {
  const list = Array.isArray(input) ? input : (input?.events || [])
  return list.map(event => {
    const metadata = parseMetadata(event.metadata)
    const ts = parseTime(event.timestamp || event.created_at || event.ts)
    return {
      ...event,
      type: event.type || metadata.type || '',
      from: event.from || event.from_id || event.agent_id || null,
      to: event.to || event.to_id || null,
      agent_id: event.agent_id || null,
      metadata,
      ts,
    }
  }).filter(event => ACTIVITY_TYPES.has(event.type) && (!Number.isFinite(event.ts) || event.ts >= sinceMs))
}

function activityByAgent(events, now, config) {
  const byAgent = new Map()
  const lastRealActivityMs = new Map()
  for (const event of events) {
    const agentId = event.from || event.agent_id
    if (!agentId || agentId === OWNER_ID) continue
    const stats = byAgent.get(agentId) || emptyActivityStats()
    stats.events += 1
    if (Number.isFinite(event.ts)) stats.lastAnyMs = Math.max(stats.lastAnyMs || 0, event.ts)
    if (event.type === 'activity' || event.type === 'turn_ended') {
      stats.activity += 1
      if (Number.isFinite(event.ts)) {
        stats.lastActivityMs = Math.max(stats.lastActivityMs || 0, event.ts)
        lastRealActivityMs.set(agentId, Math.max(lastRealActivityMs.get(agentId) || 0, event.ts))
      }
    }
    if (PROGRESS_TYPES.has(event.type)) {
      stats.progress += 1
      if (Number.isFinite(event.ts)) stats.lastProgressMs = Math.max(stats.lastProgressMs || 0, event.ts)
    }
    byAgent.set(agentId, stats)
  }
  return { byAgent, lastRealActivityMs }
}

function emptyActivityStats() {
  return { events: 0, activity: 0, progress: 0, lastAnyMs: 0, lastActivityMs: 0, lastProgressMs: 0 }
}

function activeTimerAgentSet(events, agents, now) {
  const agentIds = new Set(agents.map(agent => agent.id))
  const active = new Set()
  for (const event of events) {
    if (event.type !== 'timer') continue
    if (event.metadata?.pending !== true) continue
    const fireAt = parseTime(event.metadata.fire_at)
    if (Number.isFinite(fireAt) && fireAt <= now) continue
    if (agentIds.has(event.from)) active.add(event.from)
    if (agentIds.has(event.to)) active.add(event.to)
  }
  return active
}

function skipLiveAgentSet(events, now, windowMs) {
  const set = new Set()
  for (const event of events) {
    if (event.type !== 'chat' || event.from !== OWNER_ID || !event.to) continue
    if (Number.isFinite(event.ts) && now - event.ts <= windowMs) set.add(event.to)
  }
  return set
}

function telemetryAttentionItems(status) {
  const items = []
  const attention = Array.isArray(status?.attention) ? status.attention : []
  for (const item of attention) {
    const label = itemLabel(item)
    if (label) items.push({ label, raw: item })
  }
  const routes = status?.routes && typeof status.routes === 'object' ? Object.entries(status.routes) : []
  for (const [name, route] of routes) {
    if (route?.status === 'attention') items.push({ label: `${humanize(name)} needs attention`, raw: route })
  }
  if (status?.ws?.status === 'attention') items.push({ label: 'WebSocket path needs attention', raw: status.ws })
  return dedupeByLabel(items)
}

function rosterRouteEvidence(rosterTruth) {
  const map = new Map()
  const list = Array.isArray(rosterTruth?.agents) ? rosterTruth.agents : []
  for (const item of list) {
    const id = item.id || item.agent_id
    if (!id) continue
    map.set(id, item)
  }
  return map
}

function hasRouteEvidence(agent, rosterRoute) {
  const truth = rosterRoute.get(agent.id)
  if (!truth) return false
  if (truth.route === false || truth.route === 'none' || truth.via === 'none') return false
  if (truth.route || truth.via || truth.machine_id || truth.machine || truth.session || truth.pane) return true
  return false
}

function isActiveTask(task) {
  return ['pending', 'working', 'idle', 'blocked'].includes(String(task.status || '').toLowerCase())
}

function taskLooksWaiting(task) {
  const text = `${task.status || ''} ${task.description || ''} ${task.summary || ''}`.toLowerCase()
  return /\b(blocked|waiting|timer|paused|external|permission)\b/.test(text)
}

function taskAgeMs(task, now) {
  const ts = parseTime(task.delegated_at || task.created_at || task.updated_at)
  return Number.isFinite(ts) ? Math.max(0, now - ts) : null
}

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value) return NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

function parseMetadata(metadata) {
  if (!metadata) return {}
  if (typeof metadata === 'object') return metadata
  try { return JSON.parse(metadata) } catch { return {} }
}

function mergeActivityMaps(primary, secondary) {
  const map = new Map()
  if (primary && typeof primary.entries === 'function') {
    for (const [key, value] of primary) if (Number.isFinite(value)) map.set(key, value)
  }
  if (secondary && typeof secondary.entries === 'function') {
    for (const [key, value] of secondary) map.set(key, Math.max(map.get(key) || 0, value || 0))
  }
  return map
}

function mergeSets(a, b) {
  const set = new Set()
  if (a && typeof a.values === 'function') for (const value of a) set.add(value)
  if (b && typeof b.values === 'function') for (const value of b) set.add(value)
  return set
}

function chooseStatus(counts) {
  if (counts.moving > 0) return 'moving'
  if (counts.needsHuman > 0) return 'needs-human'
  if (counts.toddWillKick > 0 || counts.quiet > 0) return 'quiet'
  if (counts.waiting > 0) return 'stalled'
  return 'quiet'
}

function statusLabel(status) {
  if (status === 'needs-human') return 'needs human'
  return status
}

function shortState(state) {
  if (state === 'needsHuman') return 'needs you'
  if (state === 'toddWillKick') return 'Todd kick'
  return state
}

function stateRank(state) {
  return { needsHuman: 0, toddWillKick: 1, quiet: 2, waiting: 3, moving: 4 }[state] ?? 5
}

function displayAgent(agent) {
  return agent?.friendly_name || agent?.display_name || agent?.name || 'unnamed agent'
}

function countBar(label, count) {
  const width = Math.max(1, Math.min(20, count))
  const bar = count > 0 ? '#'.repeat(width) : '-'
  return `${label.padEnd(10)} ${bar.padEnd(20)} ${count}`
}

function toddLine(count) {
  if (count <= 0) return 'Todd: no quiet task needs a Todd kick under the current rules.'
  return `Todd: ${count} quiet task${count === 1 ? '' : 's'} would be nudged or respawned on the next sweep.`
}

function actionLine(status, needsHuman) {
  if (needsHuman > 0) return `Action: ${needsHuman} item${needsHuman === 1 ? '' : 's'} may need manual attention.`
  if (status === 'moving') return 'Action: no manual action needed.'
  return 'Action: watch the quiet tasks; Todd can nudge the kickable ones.'
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  if (ms < 60_000) return '<1m'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  const rem = min % 60
  return rem ? `${hr}h ${rem}m` : `${hr}h`
}

function formatAgeFrom(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0) return 'unknown'
  return `${formatDuration(Math.max(0, now - ts))} ago`
}

function itemLabel(item) {
  if (!item) return ''
  if (typeof item === 'string') return item
  return item.label || item.title || item.message || item.area || item.name || ''
}

function humanize(value) {
  return String(value || '').replace(/[-_]+/g, ' ')
}

function dedupeByLabel(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (!item.label || seen.has(item.label)) continue
    seen.add(item.label)
    out.push(item)
  }
  return out
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
