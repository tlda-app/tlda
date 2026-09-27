/**
 * Carry the reader's fleet panels across a book teleport.
 *
 * A book mounts one member per room, so a chapter switch lands in a store that
 * has never seen the reader's layout. The snapshot is taken from the outgoing
 * editor while it is still mounted; the arrival recreates it around the new
 * chapter's document. Positioning reuses the wrap rule (`planFleetLayoutWrap`)
 * with the old document's bounds as source and the new one's as target — the
 * same three-move shape as `activateSpatialDocument`, split across the remount.
 * The HUD anchor itself is never migrated: the arrival dispatches the existing
 * wrap event and the FleetHUD handler translates and re-saves it.
 *
 * The bare-room guard is the whole safety case: a chapter the reader already
 * arranged keeps its own layout and is never touched. No clobber, ever.
 */

import type { Editor, TLShape } from 'tldraw'
import { planFleetLayoutWrap, type FleetLayoutWrapPlan, type WrapDocumentBounds } from './shapes/fleet-layout-wrap'
import { fleetPanelDefaultProps } from './shapes/fleet-panel-registry'
import { isFleetShapeForOwnerKey } from './shapes/fleet-ownership'
import { isDocumentPageShape } from './shapes/document-pages'
import { carriedPropsFor } from './bookFleetCarryProps'
import { getHumanId, getDeviceId } from './fleet/fleet-data.mjs'

export type CarriedPanel = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  props: Record<string, unknown>
}

export type FleetCarrySnapshot = {
  panels: CarriedPanel[]
  source: WrapDocumentBounds
  userId: string
  deviceId: string
}

/**
 * The primary document's bounds, viewport-independent. Mirrors the primary
 * selection in `spatialWorldDocuments` (document pages except temporary
 * markdown columns and spatial-world documents) but reads min/max directly:
 * the visible-place variant moves with the scroll position, and a migration
 * source must not depend on where the reader was looking.
 */
function primaryDocumentBounds(editor: Editor): WrapDocumentBounds | null {
  const pages = editor.getCurrentPageShapes().filter(isDocumentPageShape)
    .filter((shape: TLShape) => {
      const meta = shape.meta as Record<string, unknown> | undefined
      return !meta?.temporaryMarkdownColumn && !meta?.spatialWorldDocument
    })
  let minX = Infinity, minY = Infinity, maxRight = -Infinity, maxBottom = -Infinity
  let counted = 0
  for (const page of pages) {
    const bounds = editor.getShapePageBounds(page.id)
    if (!bounds) continue
    counted++
    if (bounds.x < minX) minX = bounds.x
    if (bounds.y < minY) minY = bounds.y
    if (bounds.x + bounds.w > maxRight) maxRight = bounds.x + bounds.w
    if (bounds.y + bounds.h > maxBottom) maxBottom = bounds.y + bounds.h
  }
  if (counted === 0) return null
  return { x: minX, y: minY, w: maxRight - minX, h: maxBottom - minY }
}

/**
 * Snapshot this session's fleet layout for a teleport. Null when there is
 * nothing to carry (no owned panels, no identity, no document bounds).
 */
export function snapshotOwnedFleetLayout(editor: Editor): FleetCarrySnapshot | null {
  const userId = getHumanId()
  const deviceId = getDeviceId()
  if (!userId || !deviceId) return null
  const panels: CarriedPanel[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    if (!isFleetShapeForOwnerKey(shape, userId, deviceId)) continue
    const bounds = editor.getShapePageBounds(shape.id)
    if (!bounds) continue
    panels.push({
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      w: bounds.w,
      h: bounds.h,
      props: { ...(shape.props as unknown as Record<string, unknown>) },
    })
  }
  if (panels.length === 0) return null
  const source = primaryDocumentBounds(editor)
  if (!source) return null
  return { panels, source, userId, deviceId }
}

export type FleetCarryResult =
  | { status: 'carried'; plan: FleetLayoutWrapPlan }
  | { status: 'kept' }
  | { status: 'not-ready' }

/**
 * Recreate a snapshot around this editor's document. `carried` returns the
 * wrap plan for the anchor dispatch; `kept` means the room already holds this
 * session's layout and keeps it (never a retry); `not-ready` means the
 * document has no bounds yet (the caller retries).
 */
export function carryFleetLayoutToEditor(editor: Editor, snapshot: FleetCarrySnapshot): FleetCarryResult {
  const owned = editor.getCurrentPageShapes()
    .filter(shape => isFleetShapeForOwnerKey(shape, snapshot.userId, snapshot.deviceId))
  if (owned.length > 0) return { status: 'kept' }
  const target = primaryDocumentBounds(editor)
  if (!target) return { status: 'not-ready' }
  const plan = planFleetLayoutWrap({ panels: snapshot.panels, source: snapshot.source, target })
  const moveById = new Map(plan.moves.map(move => [move.id, move]))
  const existing = new Set<string>(editor.getCurrentPageShapes().map(shape => shape.id))
  const creates: Array<{ id: string; type: string; x: number; y: number; props: Record<string, unknown> }> = []
  for (const panel of snapshot.panels) {
    // Rooms are separate stores, so the deterministic slot ids are safe to
    // recreate verbatim; the skip is belt-and-braces against a double carry.
    if (existing.has(panel.id)) continue
    const move = moveById.get(panel.id)
    creates.push({
      id: panel.id,
      type: panel.type,
      x: move ? move.x : panel.x,
      y: move ? move.y : panel.y,
      props: {
        ...fleetPanelDefaultProps(panel.type),
        ...carriedPropsFor(panel.type, panel.props),
        userId: snapshot.userId,
        deviceId: snapshot.deviceId,
        w: panel.w,
        h: panel.h,
      },
    })
  }
  // Every id already present: the room effectively holds the layout.
  if (creates.length === 0) return { status: 'kept' }
  // Layout bookkeeping, not a document edit — off the undo stack like the wrap.
  // The boundary cast is the shape-plan equivalent of the layout planner's own
  // untyped plan: ids and types are carried verbatim from live shapes.
  type CreateShapesArg = Parameters<Editor['createShapes']>[0]
  editor.run(() => { editor.createShapes(creates as unknown as CreateShapesArg) }, { history: 'ignore' })
  return { status: 'carried', plan }
}
