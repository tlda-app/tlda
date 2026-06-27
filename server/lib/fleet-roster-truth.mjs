function agentName(agent) {
  return agent.friendly_name || agent.name || agent.id
}

function rowForAgent(agent, now = Date.now()) {
  const lastSeenMs = agent.last_seen ? now - new Date(agent.last_seen).getTime() : null
  const act = agent.metadata?.status || null
  return {
    id: agent.id,
    name: agentName(agent),
    status: agent.dead ? 'dead' : agent.status,
    last_seen_ago_s: lastSeenMs == null ? null : Math.round(lastSeenMs / 1000),
    cwd: agent.cwd || null,
    machine_id: agent.machine_id || null,
    tmux_session: agent.tmux_session || null,
    activity: act?.state || null,
    tool: act?.tool || null,
  }
}

export function fleetRosterTotals(roster) {
  const totals = { awake: 0, hibernating: 0, dead: 0, total: roster.length }
  for (const agent of roster) {
    if (agent.dead) totals.dead++
    else if (agent.status === 'awake') totals.awake++
    else totals.hibernating++
  }
  return totals
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
  const rows = (matched || agentRoster).slice(0, capped).map(a => rowForAgent(a, now))

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
    const e = entry(agent.machine_id)
    e.registry.total++
    if (agent.dead) e.registry.dead++
    else if (agent.status === 'awake') e.registry.awake++
    else e.registry.hibernating++
  }

  for (const machineId of Object.keys(machineSessions)) entry(machineId)

  const activeBySession = new Map()
  for (const agent of agentRoster) {
    if (agent.dead || !agent.tmux_session) continue
    const key = `${agent.machine_id || 'unassigned'}\u0000${agent.tmux_session}`
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
      const hasAwakeMatch = matches.some(a => a.status === 'awake')
      if (!hasAwakeMatch) {
        e.panes.stale++
        if (e.stale_panes.length < 25) {
          e.stale_panes.push({
            tmux_session: session,
            reason: matches.length ? 'registered but not awake' : 'no active registry row',
            agents: matches.map(a => ({ id: a.id, name: agentName(a), status: a.status })),
          })
        }
      }
    }
    for (const agent of agentRoster) {
      if (agent.dead || (agent.machine_id || 'unassigned') !== machineId || !agent.tmux_session) continue
      if (!sessionSet.has(agent.tmux_session)) {
        e.registry_without_pane++
        if (e.registry_without_pane_rows.length < 25) {
          e.registry_without_pane_rows.push({
            id: agent.id,
            name: agentName(agent),
            status: agent.status,
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
    agents: rows,
    shown: rows.length,
    matched: (matched || agentRoster).length,
  }
}
