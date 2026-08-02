export const FLEET_PILL_STALE_MS = 10_000
export const FLEET_PILL_LEGACY_GRACE_MS = 3_000

const activePills = new Set<string>()

export function markFleetPillActive(id: string) { activePills.add(id) }
export function markFleetPillInactive(id: string) { activePills.delete(id) }
export function isFleetPillActive(id: string) { return activePills.has(id) }
export function getActiveFleetPillIds() { return [...activePills] }

export type FleetPillPolicyRecord = {
  id: string
  type: string
  props?: { userId?: string; deviceId?: string; createdAt?: number; ephemeral?: boolean }
}

export function shouldReclaimFleetPill(
  pill: FleetPillPolicyRecord,
  now: number,
  identity: { userId: string; deviceId: string },
) {
  if (pill.type !== 'fleet-pill' || isFleetPillActive(pill.id)) return false
  const props = pill.props || {}
  const legacy = !props.userId && !props.deviceId && props.createdAt == null && props.ephemeral == null
  if (legacy) return true
  if (props.ephemeral !== true) return false
  const ownerlessTransient = !props.userId && !props.deviceId
  if (!ownerlessTransient) {
    if (!identity.userId || !identity.deviceId) return false
    if (props.userId !== identity.userId || props.deviceId !== identity.deviceId) return false
  }
  return typeof props.createdAt !== 'number' || now - props.createdAt >= FLEET_PILL_STALE_MS
}
