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

function getConfiguredSpawnMachine(fleetStore, identity) {
  if (!identity?.id || !fleetStore?.getFleetPref) return null
  const value = fleetStore.getFleetPref(identity.id, SPAWN_MACHINE_PREF_KEY)
  return typeof value === 'string' && value.trim() ? value.trim() : null
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

function documentedDefaultMachine(identity, daemonConnections) {
  const daemons = connectedDaemonAddresses(daemonConnections)
  if (!identity?.human && identity?.machine_id && identity?.env_name) {
    return {
      machine_id: identity.machine_id,
      env_name: identity.env_name,
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

export function resolveSpawnMachine({ caller, targetAgent, fresh, respawn, refresh, fleetStore, daemonConnections, onDaemonMissing }) {
  if ((respawn || refresh) && targetAgent) {
    return {
      ...requireConnected(targetAgent.machine_id, daemonConnections, `target ${targetAgent.id || targetAgent.friendly_name || 'agent'}`, onDaemonMissing, targetAgent.env_name),
      source: 'target-agent-machine',
    }
  }
  if (respawn || refresh) {
    throw new Error('respawn/refresh target agent is required to route spawn')
  }

  if (fresh && targetAgent) {
    return {
      ...requireConnected(targetAgent.machine_id, daemonConnections, `route anchor ${targetAgent.id || targetAgent.friendly_name || 'agent'}`, onDaemonMissing, targetAgent.env_name),
      source: 'route-agent-machine',
    }
  }

  if (!fresh) {
    const inferred = documentedDefaultMachine(caller, daemonConnections)
    return {
      ...requireConnected(inferred.machine_id, daemonConnections, `caller ${caller?.id || 'identity'} default spawn machine`, onDaemonMissing, inferred.env_name),
      source: inferred.source,
    }
  }

  const configured = getConfiguredSpawnMachine(fleetStore, caller)
  if (configured) {
    return {
      ...requireConnected(configured, daemonConnections, `caller ${caller.id} configured spawn machine`, onDaemonMissing, caller.env_name),
      source: 'caller-configured-spawn-machine',
    }
  }

  const inferred = documentedDefaultMachine(caller, daemonConnections)
  return {
    ...requireConnected(inferred.machine_id, daemonConnections, `caller ${caller?.id || 'identity'} default spawn machine`, onDaemonMissing, inferred.env_name),
    source: inferred.source,
  }
}
