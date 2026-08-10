import type { Editor } from 'tldraw'
import { isDocumentPageShape } from './document-pages'
import { FLEET_SHAPE_TYPES } from './fleet-panel-registry'

/** Horizontal offset for an (identity, device) layout. PURE (no room context) so
 *  the HUD can recompute the identical dx from (identity, device) alone and
 *  compensate it. */
export function layoutOffset(userId: string, deviceId: string): { dx: number; dy: number } {
  if (!userId || !deviceId) return { dx: 0, dy: 0 }
  const key = `${userId}|${deviceId}`
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
  const col = Math.abs(hash) % 16
  return { dx: -col * 4000, dy: 0 }
}

/** Vertical spacing between two owners' fleet layouts. */
const LANE_STEP = 20000

/** How far ahead of the document's near edge a layout starts along the axis the
 *  pages flow. Not observable — the HUD pins that axis to the screen, so this
 *  cancels out of anything anyone sees. It is the stable base the lane
 *  arithmetic below counts from. */
export const CANONICAL_FLOW_LEAD = 1200

function canonicalBaseY(editor: Editor): number {
  const pages = editor.getCurrentPageShapes().filter(isDocumentPageShape)
  let minTop = Infinity
  for (const p of pages) {
    const b = editor.getShapePageBounds(p.id)
    if (b && b.y < minTop) minTop = b.y
  }
  return isFinite(minTop) ? minTop - CANONICAL_FLOW_LEAD : 0
}

function occupiedLanes(editor: Editor, myId: string, myDevice: string): { base: number; occupied: Set<number> } {
  const base = canonicalBaseY(editor)
  const isMineOrLegacy = (s: any) =>
    s.props?.userId === myId && (s.props?.deviceId === myDevice || !s.props?.deviceId)
  const ownerMinY = new Map<string, number>()
  for (const s of editor.getCurrentPageShapes()) {
    if (!FLEET_SHAPE_TYPES.has(s.type as string)) continue
    if (isMineOrLegacy(s)) continue
    const uid = (s as any).props?.userId, dev = (s as any).props?.deviceId
    if (!uid || !dev) continue
    const key = `${uid}::${dev}`
    const y = (s as any).y
    const cur = ownerMinY.get(key)
    if (cur === undefined || y < cur) ownerMinY.set(key, y)
  }
  const occupied = new Set<number>()
  for (const y of ownerMinY.values()) occupied.add(Math.round((y - base) / LANE_STEP))
  return { base, occupied }
}

/** Guaranteed-disjoint vertical offset for THIS (identity, device) layout. */
export function laneDy(editor: Editor, myId: string, myDevice: string): number {
  if (!myId || !myDevice) return 0
  const { occupied } = occupiedLanes(editor, myId, myDevice)
  let lane = 0
  while (occupied.has(lane)) lane++
  return lane * LANE_STEP
}
