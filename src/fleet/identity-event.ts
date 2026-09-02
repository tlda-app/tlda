export type FleetIdentityState = {
  id: string | null
  name: string | null
  identityResolved: boolean
  needsIdentity: boolean
}

export function fleetIdentityStateFromEvent(
  ev: Partial<FleetIdentityState>,
  fallback: FleetIdentityState,
): FleetIdentityState {
  return {
    id: Object.hasOwn(ev, 'id') ? ev.id ?? null : fallback.id,
    name: Object.hasOwn(ev, 'name') ? ev.name ?? null : fallback.name,
    identityResolved: ev.identityResolved ?? fallback.identityResolved,
    needsIdentity: ev.needsIdentity ?? fallback.needsIdentity,
  }
}
