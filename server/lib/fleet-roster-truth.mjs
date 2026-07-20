import { activityHealthForProjection } from '../../shared/activity-health.mjs'
import { isRuntimeAwake, runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'

function agentName(agent) {
  return agent.friendly_name || agent.name || agent.id
}

function agentDaemonKey(agent) {
  if (agent.runtime_status?.route?.daemon_key) return agent.runtime_status.route.daemon_key
  if (agent.daemon_key) return agent.daemon_key
  if (agent.daemonKey) return agent.daemonKey
  if (agent.machine_id && agent.env_name) return `${agent.machine_id}:${agent.env_name}`
  return agent.machine_id || 'unassigned'
}

function rowForAgent(agent, now = Date.now()) {
  const lastSeenMs = agent.last_seen ? now - new Date(agent.last_seen).getTime() : null
  const act = agent.metadata?.status || null
  const runtimeRoute = agent.runtime_status?.route || null
  return {
    id: agent.id,
    name: agentName(agent),
    status: agent.dead ? 'dead' : runtimeStatusName(agent),
    last_seen_ago_s: lastSeenMs == null ? null : Math.round(lastSeenMs / 1000),
    cwd: agent.cwd || null,
    model: agent.metadata?.model || null,
    inbox_status: agent.metadata?.inboxStatus || null,
    inbox_status_tag: agent.metadata?.inboxStatusTag || null,
    delivery_channel: agent.metadata?.deliveryChannel || null,
    machine_id: agent.machine_id || null,
    env_name: agent.env_name || null,
    daemon_key: runtimeRoute?.daemon_key || agentDaemonKey(agent),
    tmux_session: runtimeRoute?.tmux_session || agent.tmux_session || null,
    activity: act?.state || null,
    tool: act?.tool || null,
    activity_health: activityHealthForProjection(agent.metadata || {}),
  }
}

export function fleetRosterTotals(roster) {
  const totals = { awake: 0, hibernating: 0, dead: 0, total: roster.length }
  for (const agent of roster) {
    if (agent.dead) totals.dead++
    else if (isRuntimeAwake(agent)) totals.awake++
    else totals.hibernating++
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
  const agentRoster = (roster || []).filter(a => !a.human)
  const totals = fleetRosterTotals(agentRoster)
  const capped = Math.max(1, Math.min(Number(limit) || 50, 500))
  const matchedRoster = matched || agentRoster
  const rows = matchedRoster.slice(0, capped).map(a => rowForAgent(a, now))
  const summary = {
    models: countValues(matchedRoster, a => a.metadata?.model || null),
    inbox_statuses: countValues(matchedRoster, a => a.metadata?.inboxStatus || null),
    delivery_channels: countValues(matchedRoster, a => a.metadata?.deliveryChannel || null),
    working_dirs: countValues(matchedRoster, a => a.cwd || null),
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
    const e = entry(agentDaemonKey(agent))
    e.registry.total++
    if (agent.dead) e.registry.dead++
    else if (isRuntimeAwake(agent)) e.registry.awake++
    else e.registry.hibernating++
  }

  for (const machineId of Object.keys(machineSessions)) entry(machineId)

  const activeBySession = new Map()
  for (const agent of agentRoster) {
    if (agent.dead || !agent.tmux_session) continue
    const key = `${agentDaemonKey(agent)}\u0000${agent.tmux_session}`
    if (!activeBySession.has(key)) activeBySession.set(key, [])
    activeBySession.get(key).push(agent)
  }

  for (const [machineId, sessionsRaw] of Object.entries(machineSessions)) {
    const e = entry(machineId)
    const sessions = (sessionsRaw || []).filter(s => typeof s === 'string' && s.startsWith('fleet-'))
    const sessionSet = new Set(sessions)
    e.daemon_connected = true
    e.panes.fleet = sessions.length
    for (const session of sessions) {
      const matches = activeBySession.get(`${machineId}\u0000${session}`) || []
      const hasAwakeMatch = matches.some(a => isRuntimeAwake(a))
      if (!hasAwakeMatch) {
        e.panes.stale++
        if (e.stale_panes.length < 25) {
          e.stale_panes.push({
            tmux_session: session,
            reason: matches.length ? 'registered but not awake' : 'no active registry row',
            agents: matches.map(a => ({ id: a.id, name: agentName(a), status: runtimeStatusName(a) })),
          })
        }
      }
    }
    for (const agent of agentRoster) {
      if (agent.dead || agentDaemonKey(agent) !== machineId || !agent.tmux_session) continue
      if (!sessionSet.has(agent.tmux_session)) {
        e.registry_without_pane++
        if (e.registry_without_pane_rows.length < 25) {
          e.registry_without_pane_rows.push({
            id: agent.id,
            name: agentName(agent),
            status: runtimeStatusName(agent),
            daemon_key: agentDaemonKey(agent),
            tmux_session: agent.tmux_session,
          })
        }
      }
    }
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
