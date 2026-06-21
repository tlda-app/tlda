export const SPAWN_MACHINE_PREF_KEY = 'spawn_machine_id'

// Spawn routing is identity-based, not device-based:
// - fresh spawn: caller's configured fleet_prefs.spawn_machine_id
// - respawn/refresh: target agent's known machine_id
// Defaults are deliberately narrow and visible. A non-human agent defaults to
// its own machine; any identity may use the sole connected daemon as bootstrap
// when no preference exists. Multiple connected daemons without a preference
// fail loud instead of guessing.

function connectedMachineIds(daemonConnections) {
  return [...(daemonConnections?.keys?.() || [])]
}

function getConfiguredSpawnMachine(fleetStore, identity) {
  if (!identity?.id || !fleetStore?.getFleetPref) return null
  const value = fleetStore.getFleetPref(identity.id, SPAWN_MACHINE_PREF_KEY)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requireConnected(machineId, daemonConnections, context, onDaemonMissing) {
  if (!machineId) throw new Error(`${context} has no spawn machine configured — cannot spawn agents`)
  if (!daemonConnections?.has?.(machineId)) {
    onDaemonMissing?.(machineId, context, { hasWs: false, readyState: 'missing' })
    throw new Error(`No fleet daemon connected for machine "${machineId}" (${context}) — cannot spawn agents`)
  }
  return { machine_id: machineId }
}

function documentedDefaultMachine(identity, daemonConnections) {
  const machines = connectedMachineIds(daemonConnections)
  if (!identity?.human && identity?.machine_id) {
    return {
      machine_id: identity.machine_id,
      source: 'agent-own-machine',
    }
  }
  if (machines.length === 1) {
    return {
      machine_id: machines[0],
      source: 'sole-connected-daemon',
    }
  }
  if (machines.length === 0) {
    throw new Error('No fleet daemon connected — cannot spawn agents')
  }
  throw new Error(
    `spawn machine is not configured for ${identity?.id || 'caller'} and ${machines.length} daemons are connected (${machines.join(', ')}) — set ${SPAWN_MACHINE_PREF_KEY}`,
  )
}

export function resolveSpawnMachine({ caller, targetAgent, fresh, respawn, refresh, fleetStore, daemonConnections, onDaemonMissing }) {
  if ((respawn || refresh) && targetAgent) {
    return {
      ...requireConnected(targetAgent.machine_id, daemonConnections, `target ${targetAgent.id || targetAgent.friendly_name || 'agent'}`, onDaemonMissing),
      source: 'target-agent-machine',
    }
  }
  if (respawn || refresh) {
    throw new Error('respawn/refresh target agent is required to route spawn')
  }

  if (!fresh) {
    const inferred = documentedDefaultMachine(caller, daemonConnections)
    return {
      ...requireConnected(inferred.machine_id, daemonConnections, `caller ${caller?.id || 'identity'} default spawn machine`, onDaemonMissing),
      source: inferred.source,
    }
  }

  const configured = getConfiguredSpawnMachine(fleetStore, caller)
  if (configured) {
    return {
      ...requireConnected(configured, daemonConnections, `caller ${caller.id} configured spawn machine`, onDaemonMissing),
      source: 'caller-configured-spawn-machine',
    }
  }

  const inferred = documentedDefaultMachine(caller, daemonConnections)
  return {
    ...requireConnected(inferred.machine_id, daemonConnections, `caller ${caller?.id || 'identity'} default spawn machine`, onDaemonMissing),
    source: inferred.source,
  }
}
