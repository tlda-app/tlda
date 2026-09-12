import { activityHealthForProjection } from '../../shared/activity-health.mjs'
import { fleetRosterCategory, runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'

function agentName(agent) {
  return agent.friendly_name || agent.name || agent.id
}

function rowForAgent(agent, now = Date.now()) {
  const lastSeenMs = agent.last_seen ? now - new Date(agent.last_seen).getTime() : null
  const runtime = agent.runtime_status || null
  return {
    id: agent.id,
    name: agentName(agent),
    parent_agent_id: agent.parent_agent_id || null,
    human: !!agent.human,
    labels: Array.isArray(agent.labels) ? agent.labels : [],
    status: agent.dead ? 'dead' : runtimeStatusName(agent),
    // A reserved shell — a mint whose `login()` never completed — projects as
    // `hibernating`, because the projection's shell branch returns that status
    // and carries the distinction in `reason: 'reserved-shell-unclaimed'`
    // instead. So the row said `hibernating` about an agent that has never run,
    // while the totals line beside it counted the same agent under `pending`.
    //
    // That gap is not cosmetic: a message to one of these returns at the
    // `isReservedShellAgent` branch of `requestWake` BEFORE any notification is
    // attempted and before any symptom reaches a daemon, so it wakes nothing and
    // reports nothing. Measured 2026-09-12: 1,674 of them, and a caller reading
    // the roster had no way to tell one from an agent that is merely asleep.
    //
    // Carried as its own field rather than derived on the client from `reason`,
    // which is free-form provenance. AGENTS.md §"Our client/server lines can
    // move": what the server sends is the thing to change.
    pending: !!agent.metadata?.shell,
    last_seen_ago_s: lastSeenMs == null ? null : Math.round(lastSeenMs / 1000),
    model: agent.metadata?.model || null,
    inbox_status: agent.metadata?.inboxStatus || null,
    inbox_status_tag: agent.metadata?.inboxStatusTag || null,
    delivery_channel: agent.metadata?.deliveryChannel || null,
    activity: runtime?.activity || null,
    tool: runtime?.evidence?.activity_tool || null,
    // `activity` without `activity_at` is a state with no age. The authoritative
    // daemon scan advances this timestamp only when its pane classification
    // changes, while liveness scans may continue to confirm the process exists.
    activity_at: runtime?.evidence?.activity_at || null,
    runtime_status: runtime,
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
