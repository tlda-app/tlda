// @ts-ignore — vanilla JS module
import { getHumanId, getDeviceId, isDeviceReady } from '../fleet/fleet-data.mjs'
// @ts-ignore — vanilla JS module
import { readIdentityEpoch } from '../fleet/identity-epoch.mjs'
import { FLEET_SHAPE_TYPES } from './fleet-panel-registry'

export const FLEET_HUD_ANCHOR_ID = 'shape:fleet-hud-anchor' as const

export function getMyAnchorId(): string {
  const uid = getHumanId()
  if (!uid) return FLEET_HUD_ANCHOR_ID
  const dev = getDeviceId()
  return getAnchorIdForOwnerKey(uid, dev)
}

export function getAnchorIdForOwnerKey(userId: string, deviceId: string): string {
  if (!userId || !deviceId) return FLEET_HUD_ANCHOR_ID
  return `shape:fleet-hud-anchor--${userId.replace('fleet:', '')}--${deviceId}`
}

export function isFleetShapeForOwnerKey(s: any, userId: string, deviceId: string): boolean {
  if (!FLEET_SHAPE_TYPES.has(s.type as string)) return false
  const uid = s.props?.userId
  const dev = s.props?.deviceId
  return !!uid && uid === userId && !!dev && dev === deviceId
}

/**
 * A fleet shape belongs to the current session iff BOTH its userId (identity)
 * and deviceId match this browser. Shapes with missing ownership belong to no
 * one; callers must not claim them as a fallback.
 */
export function isMyFleetShape(s: any): boolean {
  // Read the epoch so TLDraw's isShapeHidden computed captures it as a parent
  // and re-runs when identity or device id changes. Without this the verdict
  // is pinned at first evaluation.
  readIdentityEpoch()
  if (!isDeviceReady()) return false
  const myId = getHumanId()
  const myDevice = getDeviceId()
  return isFleetShapeForOwnerKey(s, myId, myDevice)
}
