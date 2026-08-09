import { activityHealthForProjection } from '../../shared/activity-health.mjs'
import { fleetRosterCategory, runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'

function agentName(agent) {
  return agent.friendly_name || agent.name || agent.id
}

function rowForAgent(agent, now = Date.now()) {
  const lastSeenMs = agent.last_seen ? now - new Date(agent.last_seen).getTime() : null
  const act = agent.metadata?.status || null
  return {
    id: agent.id,
    name: agentName(agent),
    parent_agent_id: agent.parent_agent_id || null,
    human: !!agent.human,
    labels: Array.isArray(agent.labels) ? agent.labels : [],
    status: agent.dead ? 'dead' : runtimeStatusName(agent),
    last_seen_ago_s: lastSeenMs == null ? null : Math.round(lastSeenMs / 1000),
    model: agent.metadata?.model || null,
    inbox_status: agent.metadata?.inboxStatus || null,
    inbox_status_tag: agent.metadata?.inboxStatusTag || null,
    delivery_channel: agent.metadata?.deliveryChannel || null,
    activity: act?.state || null,
    tool: act?.tool || null,
    // `activity` without `activity_at` is a state with no age, and the age is
    // the whole signal for a watcher: `reportStatus` fires on every tlda MCP
    // tool call, so this is the last time the agent's OWN client reached the
    // server. Read against `last_seen` — which the daemon advances from the
    // process — a frozen `activity_at` beside a fresh `last_seen` is an agent
    // whose process is up and whose client has stopped. Read by the dev bot's
    // `agent-receiving` check.
    activity_at: act?.ts || null,
    runtime_status: agent.runtime_status || null,
    activity_health: agent.human ? null : activityHealthForProjection(agent.metadata || {}),
  }
}

export function fleetRosterTotals(roster) {
  const totals = { awake: 0, hibernating: 0, dead: 0, total: roster.length }
  for (const agent of roster) {
    const category = fleetRosterCategory(agent)
    if (category === 'dead') totals.dead++
    else totals[category]++
  }
  return totals
}

function countValues(agents, readValue) {
  const counts = new Map()
  for (const agent of agents) {
    const value = readValue(agent)
    if (!value) continue
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

export function summarizeFleetRosterTruth({
  roster,
  matched = roster,
  limit = 50,
  machineSessions = {},
  now = Date.now(),
} = {}) {
  const agentRoster = roster || []
  const totals = fleetRosterTotals(agentRoster)
  const capped = Math.max(1, Math.min(Number(limit) || 50, 500))
  const matchedRoster = matched || agentRoster
  const rows = matchedRoster.slice(0, capped).map(a => rowForAgent(a, now))
  const summary = {
    models: countValues(matchedRoster, a => a.metadata?.model || null),
    inbox_statuses: countValues(matchedRoster, a => a.metadata?.inboxStatus || null),
    delivery_channels: countValues(matchedRoster, a => a.metadata?.deliveryChannel || null),
  }

  const machines = new Map()
  function entry(machineId) {
    const key = machineId || 'unassigned'
    if (!machines.has(key)) {
      machines.set(key, {
        machine_id: key,
        daemon_connected: Object.prototype.hasOwnProperty.call(machineSessions, key),
        registry: { awake: 0, hibernating: 0, dead: 0, total: 0 },
        panes: { fleet: 0, stale: 0 },
        registry_without_pane: 0,
        stale_panes: [],
        registry_without_pane_rows: [],
      })
    }
    return machines.get(key)
  }

  for (const agent of agentRoster) {
    const e = entry('unassigned')
    e.registry.total++
    const category = fleetRosterCategory(agent)
    if (category === 'dead') e.registry.dead++
    else e.registry[category]++
  }

  for (const machineId of Object.keys(machineSessions)) entry(machineId)

  for (const [machineId, sessionsRaw] of Object.entries(machineSessions)) {
    const e = entry(machineId)
    const sessions = (sessionsRaw || []).filter(s => typeof s === 'string' && s.startsWith('fleet-'))
    e.daemon_connected = true
    e.panes.fleet = sessions.length
  }

  const machineRows = [...machines.values()].sort((a, b) => a.machine_id.localeCompare(b.machine_id))
  const paneTotals = machineRows.reduce((acc, m) => {
    acc.fleet += m.panes.fleet
    acc.stale += m.panes.stale
    acc.registry_without_pane += m.registry_without_pane
    return acc
  }, { fleet: 0, stale: 0, registry_without_pane: 0 })

  return {
    totals,
    panes: paneTotals,
    machines: machineRows,
    summary,
    agents: rows,
    shown: rows.length,
    matched: matchedRoster.length,
  }
}
