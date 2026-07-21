import type { Editor, TLShapeId } from 'tldraw'
// @ts-ignore -- vanilla JS module
import { getDeviceId, getHumanId } from '../fleet/fleet-data.mjs'

import { installFleetPillReclaimerWithIdentity } from './fleet-pill-reclaimer'
import { shouldReclaimFleetPill as shouldReclaimFleetPillPolicy } from './fleet-pill-policy'
export { FLEET_PILL_LEGACY_GRACE_MS, FLEET_PILL_STALE_MS, isFleetPillActive, markFleetPillActive, markFleetPillInactive } from './fleet-pill-policy'

export function transientFleetPillProps<T extends Record<string, unknown>>(props: T) {
  return {
    ...props,
    userId: getHumanId() || '',
    deviceId: getDeviceId() || '',
    createdAt: Date.now(),
    ephemeral: true,
  }
}

type Pill = {
  id: TLShapeId
  type: string
  x: number
  y: number
  props?: {
    userId?: string
    deviceId?: string
    createdAt?: number
    ephemeral?: boolean
  }
}

export function shouldReclaimFleetPill(
  pill: Pill,
  now: number,
  identity = { userId: getHumanId() || '', deviceId: getDeviceId() || '' },
) {
  return shouldReclaimFleetPillPolicy(pill, now, identity)
}

export function installFleetPillReclaimer(editor: Editor): () => void {
  return installFleetPillReclaimerWithIdentity(editor, {
    identity: { userId: getHumanId() || '', deviceId: getDeviceId() || '' },
  })
}
