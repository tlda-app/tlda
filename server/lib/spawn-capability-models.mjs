import { flattenAvailableSpawnModels } from '../../src/fleet/spawn-model-options.mjs'

export async function resolveFreshSpawnCapabilityModels({
  userId,
  fleetStore,
  daemonConnections,
  sendRpc,
  resolveSpawnMachine,
  onDaemonMissing,
}) {
  if (!userId || typeof userId !== 'string') {
    return { ok: false, error: 'Missing ?user= param', aliases: [], defaultAlias: '' }
  }
  if (!fleetStore) {
    return { ok: false, error: 'fleet store unavailable', aliases: [], defaultAlias: '' }
  }
  const caller = fleetStore.getAgent?.(userId)
  if (!caller) {
    return { ok: false, error: `spawn caller ${userId} is not registered`, aliases: [], defaultAlias: '' }
  }

  let route
  try {
    route = resolveSpawnMachine({
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
    const capabilities = await sendRpc(route.machine_id, 'spawn-capabilities', {})
    const flattened = flattenAvailableSpawnModels(capabilities)
    return {
      ok: true,
      machine_id: route.machine_id,
      route: route.source || null,
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
