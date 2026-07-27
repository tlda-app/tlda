import { flattenAvailableSpawnModels } from '../../shared/spawn-model-options.mjs'

export async function resolveFreshSpawnAvailabilityModels({
  userId,
  cwd = null,
  doc = null,
  fleetStore,
  daemonConnections,
  sendDaemonEphemeral,
  resolveSpawnMachine,
  onDaemonMissing,
}) {
  if (!userId || typeof userId !== 'string') {
    return { ok: false, error: 'Missing ?user= param', aliases: [], defaultAlias: '' }
  }
  if (!fleetStore) {
    return { ok: false, error: 'fleet store unavailable', aliases: [], defaultAlias: '' }
  }
  const caller = await fleetStore.getAgent(userId)
  if (!caller) {
    return { ok: false, error: `spawn caller ${userId} is not registered`, aliases: [], defaultAlias: '' }
  }

  let route
  try {
    route = await resolveSpawnMachine({
      caller,
      fresh: true,
      respawn: false,
      refresh: false,
      fleetStore,
      daemonConnections,
      onDaemonMissing,
    })
  } catch (e) {
    return { ok: false, error: e.message || String(e), aliases: [], defaultAlias: '' }
  }

  try {
    // Route to the resolved daemon by its FULL key (machine_id + env_name). Passing
    // only route.machine_id drops the env — sendDaemonEphemeral then has no env_name and rejects
    // with "No fleet-daemon connected for <machine>:(unknown)", which surfaced as the
    // mint UI's "models unavailable" even though the daemon is connected at mini:default.
    const capabilities = await sendDaemonEphemeral(route.machine_id, 'spawn-availability', {
      daemon_env_name: route.env_name,
      ...(cwd ? { cwd } : {}),
    })
    const flattened = flattenAvailableSpawnModels(capabilities)
    return {
      ok: true,
      machine_id: route.machine_id,
      route: route.source || null,
      context: {
        doc: doc || null,
        cwd: cwd || null,
      },
      capabilities,
      aliases: flattened.aliases,
      defaultAlias: flattened.defaultAlias,
    }
  } catch (e) {
    return {
      ok: false,
      machine_id: route.machine_id,
      route: route.source || null,
      error: e.message || String(e),
      aliases: [],
      defaultAlias: '',
    }
  }
}
