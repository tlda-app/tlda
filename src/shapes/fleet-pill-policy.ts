export const FLEET_PILL_STALE_MS = 10_000
export const FLEET_PILL_LEGACY_GRACE_MS = 3_000

const activePills = new Set<string>()
// When each pill was last let go of. The stale clock runs from the later of this
// and createdAt: a pill is transient because nobody is holding it, so the budget
// has to start when it was put down. Measuring from creation alone made the
// deadline elapse *during* a slow drag, so releasing a pill you had been holding
// for more than FLEET_PILL_STALE_MS reclaimed it on the spot.
const releasedAt = new Map<string, number>()

export function markFleetPillActive(id: string) {
  activePills.add(id)
  releasedAt.delete(id)
}
export function markFleetPillInactive(id: string, now: number = Date.now()) {
  // Only a pill that was actually held gets a fresh budget. The inactive mark is
  // also used as a plain cleanup on pills that were never dragged, and those
  // must keep dying on their original schedule.
  if (activePills.delete(id)) releasedAt.set(id, now)
}
export function isFleetPillActive(id: string) { return activePills.has(id) }
export function getActiveFleetPillIds() { return [...activePills] }
/** Drop all memory of a pill — call when its record leaves the store. */
export function forgetFleetPill(id: string) {
  activePills.delete(id)
  releasedAt.delete(id)
}
/** The instant a pill's stale countdown starts: put down if it ever was, else created. */
export function fleetPillStaleFrom(id: string, createdAt: number | undefined) {
  return Math.max(typeof createdAt === 'number' ? createdAt : 0, releasedAt.get(id) || 0)
}

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
  if (typeof props.createdAt !== 'number') return true
  return now - fleetPillStaleFrom(pill.id, props.createdAt) >= FLEET_PILL_STALE_MS
}
