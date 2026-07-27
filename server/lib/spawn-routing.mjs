export const SPAWN_MACHINE_PREF_KEY = 'spawn_machine_id'

function daemonKey(machineId, envName) {
  return `${machineId}:${envName}`
}

// Spawn routing is identity-based, not device-based:
// - fresh spawn: caller's configured fleet_prefs.spawn_machine_id
// - anchored fresh spawn: anchor agent's known machine_id
// - respawn/refresh: target agent's known machine_id
// Defaults are deliberately narrow and visible. A non-human agent defaults to
// its own machine; any identity may use the sole connected daemon as bootstrap
// when no preference exists. Multiple connected daemons without a preference
// fail loud instead of guessing.

function connectedDaemonAddresses(daemonConnections) {
  return [...(daemonConnections?.values?.() || [])]
    .filter(ws => ws?._machineId && ws?._envName)
    .map(ws => ({ machine_id: ws._machineId, env_name: ws._envName, key: daemonKey(ws._machineId, ws._envName) }))
}

// The sole connected daemon, or null when there are 0 or (ambiguously) >1. Used as the
// fallback for reviving an address-less seat: a hibernated agent whose machine_id/env_name
// were never persisted used to be un-revivable ("no daemon address configured"); if exactly
// one daemon is connected, that's unambiguously where it should come back.
function soleConnectedDaemon(daemonConnections) {
  const daemons = connectedDaemonAddresses(daemonConnections)
  return daemons.length === 1 ? daemons[0] : null
}

async function getConfiguredSpawnMachine(fleetStore, identity) {
  if (!identity?.id) return null
  const value = await fleetStore.getFleetPref(identity.id, SPAWN_MACHINE_PREF_KEY)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function splitDaemonKey(value) {
  const idx = String(value || '').indexOf(':')
  if (idx < 1) return { machine_id: String(value || ''), env_name: null }
  return {
    machine_id: String(value).slice(0, idx),
    env_name: String(value).slice(idx + 1) || null,
  }
}

function requireConnected(machineId, daemonConnections, context, onDaemonMissing, envName = null) {
  if (!machineId || !envName) throw new Error(`${context} has no daemon address configured — cannot spawn agents`)
  const key = daemonKey(machineId, envName)
  if (!daemonConnections?.has?.(key)) {
    onDaemonMissing?.(machineId, context, { envName, hasWs: false, readyState: 'missing' })
    throw new Error(`No fleet daemon connected for "${key}" (${context}) — cannot spawn agents`)
  }
  return { machine_id: machineId, env_name: envName }
}

function requireConnectedMachine(machineId, daemonConnections, context, onDaemonMissing) {
  const matches = connectedDaemonAddresses(daemonConnections)
    .filter(d => d.machine_id === machineId)
  if (matches.length === 1) {
    return requireConnected(machineId, daemonConnections, context, onDaemonMissing, matches[0].env_name)
  }
  if (matches.length > 1) {
    throw new Error(
      `${context} has multiple daemon environments configured for "${machineId}" (${matches.map(d => d.key).join(', ')}) — cannot spawn agents`,
    )
  }
  onDaemonMissing?.(machineId, context, { envName: null, hasWs: false, readyState: 'missing' })
  throw new Error(`No fleet daemon connected for machine "${machineId}" (${context}) — cannot spawn agents`)
}

function requireConnectedRoute(route, daemonConnections, context, onDaemonMissing) {
  if (route?.env_name) {
    return requireConnected(route.machine_id, daemonConnections, context, onDaemonMissing, route.env_name)
  }
  return requireConnectedMachine(route?.machine_id, daemonConnections, context, onDaemonMissing)
}

async function normalizeConfiguredSpawnMachine(fleetStore, identity, rawValue, route) {
  if (!identity?.id || !rawValue || !route?.machine_id || !route?.env_name) return
  const normalized = daemonKey(route.machine_id, route.env_name)
  if (rawValue === normalized) return
  await fleetStore.setFleetPref(identity.id, SPAWN_MACHINE_PREF_KEY, normalized)
}

function documentedDefaultMachine(identity, daemonConnections) {
  const daemons = connectedDaemonAddresses(daemonConnections)
  if (!identity?.human && identity?.machine_id) {
    return {
      machine_id: identity.machine_id,
      env_name: identity.env_name || null,
      source: 'agent-own-machine',
    }
  }
  if (daemons.length === 1) {
    return {
      machine_id: daemons[0].machine_id,
      env_name: daemons[0].env_name,
      source: 'sole-connected-daemon',
    }
  }
  if (daemons.length === 0) {
    throw new Error('No fleet daemon connected — cannot spawn agents')
  }
  throw new Error(
    `spawn machine is not configured for ${identity?.id || 'caller'} and ${daemons.length} daemons are connected (${daemons.map(d => d.key).join(', ')}) — set ${SPAWN_MACHINE_PREF_KEY}`,
  )
}

export async function resolveSpawnMachine({ caller, targetAgent, fresh, respawn, refresh, fleetStore, daemonConnections, onDaemonMissing }) {
  if ((respawn || refresh) && targetAgent) {
    const label = `target ${targetAgent.id || targetAgent.friendly_name || 'agent'}`
    if (targetAgent.machine_id && targetAgent.env_name) {
      return {
        ...requireConnected(targetAgent.machine_id, daemonConnections, label, onDaemonMissing, targetAgent.env_name),
        source: 'target-agent-machine',
      }
    }
    // Address-less seat (no recorded machine_id/env_name) — revive it on the sole
    // connected daemon rather than failing "no daemon address configured".
    const sole = soleConnectedDaemon(daemonConnections)
    if (sole) {
      return {
        ...requireConnected(sole.machine_id, daemonConnections, `${label} (no recorded address → sole daemon)`, onDaemonMissing, sole.env_name),
        source: 'target-agent-machine-defaulted',
      }
    }
    // 0 or ambiguous >1 daemons — keep the original loud failure (can't guess).
    return {
      ...requireConnected(targetAgent.machine_id, daemonConnections, label, onDaemonMissing, targetAgent.env_name),
      source: 'target-agent-machine',
    }
  }
  if (respawn || refresh) {
    throw new Error('respawn/refresh target agent is required to route spawn')
  }

  if (fresh && targetAgent) {
    const label = `route anchor ${targetAgent.id || targetAgent.friendly_name || 'agent'}`
    if (targetAgent.machine_id && targetAgent.env_name) {
      return {
        ...requireConnected(targetAgent.machine_id, daemonConnections, label, onDaemonMissing, targetAgent.env_name),
        source: 'route-agent-machine',
      }
    }
    const sole = soleConnectedDaemon(daemonConnections)
    if (sole) {
      return {
        ...requireConnected(sole.machine_id, daemonConnections, `${label} (no recorded address → sole daemon)`, onDaemonMissing, sole.env_name),
        source: 'route-agent-machine-defaulted',
      }
    }
    return {
      ...requireConnected(targetAgent.machine_id, daemonConnections, label, onDaemonMissing, targetAgent.env_name),
      source: 'route-agent-machine',
    }
  }

  if (!fresh) {
    const inferred = documentedDefaultMachine(caller, daemonConnections)
    return {
      ...requireConnectedRoute(inferred, daemonConnections, `caller ${caller?.id || 'identity'} default spawn machine`, onDaemonMissing),
      source: inferred.source,
    }
  }

  const configured = await getConfiguredSpawnMachine(fleetStore, caller)
  if (configured) {
    const configuredRoute = splitDaemonKey(configured)
    const route = requireConnectedRoute(configuredRoute, daemonConnections, `caller ${caller.id} configured spawn machine`, onDaemonMissing)
    await normalizeConfiguredSpawnMachine(fleetStore, caller, configured, route)
    return {
      ...route,
      source: 'caller-configured-spawn-machine',
    }
  }

  const inferred = documentedDefaultMachine(caller, daemonConnections)
  return {
    ...requireConnectedRoute(inferred, daemonConnections, `caller ${caller?.id || 'identity'} default spawn machine`, onDaemonMissing),
    source: inferred.source,
  }
}
