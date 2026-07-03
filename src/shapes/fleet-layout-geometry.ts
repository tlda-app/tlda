import type { Editor } from 'tldraw'
// @ts-ignore — vanilla JS module
import { isDeviceReady } from '../fleet/fleet-data.mjs'
import { isDocumentPageShape } from './document-pages'
import { FLEET_SHAPE_TYPES } from './fleet-panel-registry'
import { isMyFleetShape } from './fleet-ownership'

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

function canonicalBaseY(editor: Editor): number {
  const pages = editor.getCurrentPageShapes().filter(isDocumentPageShape)
  let minTop = Infinity
  for (const p of pages) {
    const b = editor.getShapePageBounds(p.id)
    if (b && b.y < minTop) minTop = b.y
  }
  return isFinite(minTop) ? minTop - 1200 : 0
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

/** Shift my whole layout to a free lane if it currently overlaps another owner. */
export function ensureMyLaneDisjoint(editor: Editor, myId: string, myDevice: string): number {
  if (!isDeviceReady()) return 0
  if (!myId || !myDevice) return 0
  const mine = editor.getCurrentPageShapes().filter(isMyFleetShape)
  if (mine.length === 0) return 0
  const bbox = (shapes: any[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of shapes) {
      const b = editor.getShapePageBounds(s.id)
      if (!b) continue
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null
  }
  const myBox = bbox(mine)
  if (!myBox) return 0
  const others = new Map<string, any[]>()
  for (const s of editor.getCurrentPageShapes()) {
    if (!FLEET_SHAPE_TYPES.has(s.type as string)) continue
    if (isMyFleetShape(s)) continue
    const uid = (s as any).props?.userId, dev = (s as any).props?.deviceId
    if (!uid || !dev) continue
    const key = `${uid}::${dev}`
    if (!others.has(key)) others.set(key, [])
    others.get(key)!.push(s)
  }
  const intersects = (a: any, b: any) =>
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
  const myKey = `${myId}::${myDevice}`
  let collides = false
  for (const [key, arr] of others) {
    const ob = bbox(arr)
    if (ob && intersects(myBox, ob) && key < myKey) { collides = true; break }
  }
  if (!collides) return 0
  const { base } = occupiedLanes(editor, myId, myDevice)
  const targetDy = laneDy(editor, myId, myDevice)
  const currentDy = Math.round((myBox.minY - base) / LANE_STEP) * LANE_STEP
  const delta = targetDy - currentDy
  if (delta === 0) return 0
  editor.run(() => {
    for (const s of mine) {
      editor.updateShape({ id: s.id, type: s.type, x: (s as any).x, y: (s as any).y + delta } as any)
    }
  }, { history: 'ignore' })
  return mine.length
}
