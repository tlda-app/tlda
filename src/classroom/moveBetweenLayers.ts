// Moving an annotation from one layer to another.
//
// Skip's first question in this thread was "so students cant submit their stuff
// to the common layer? can they write it directly?" — and then, at 02:09:
// "and prob on selection the layer menu becomes a move-to-layer menu", "like if
// you have selected an annotation". Direct writing covers making a mark on the
// class's layer; this covers doing the work privately and then putting it in
// front of the class.
//
// Layers are separate sync rooms, so this crosses stores. That is the whole
// risk: a move that half-happens is either a duplicate or a loss, and neither
// announces itself.
//
// The shape to copy is already in this codebase. `annotationVisibility.ts`
// publishes a draft by RE-CREATING it as synced rather than mutating it in
// place. So: create in the destination, confirm it arrived, and only then drop
// the original.
//
//   create → verify → delete
//
// The ordering is the guard. If the create fails the original is untouched, so
// the worst reachable outcome is that nothing happened. If the verify fails we
// stop with the shape present in both places — visibly wrong, and recoverable —
// rather than deleting on the assumption that the write landed.

import type { Editor, TLShapeId, TLShape } from 'tldraw'

/** The parts of an Editor this needs, so the ordering can be tested without a DOM. */
export interface LayerStore {
  getShape(id: TLShapeId): TLShape | undefined
  createShapes(shapes: Partial<TLShape>[]): void
  deleteShapes(ids: TLShapeId[]): void
  getCurrentPageId(): string
}

export class LayerMoveFailed extends Error {}

/**
 * The conversion between the two layers' coordinate frames.
 *
 * Skip, 2026-08-15 16:06:06 EDT, raising the move as a window-manager question:
 * *"clearly, since layers have, like, a relative position, right, the idea is,
 * like, moves happen while the layer to layer relationship is like, the
 * transforms are static, and they happen in that coordinate frame. So, you
 * know, the common coordinate frame created by the relative transform."*
 *
 * Build it from the WM with `wm.translate(point, sourceLayer, destinationLayer)`
 * — see `layerFrameConversion`. It is a required argument rather than an
 * optional one because the default it would otherwise have is the identity, and
 * the identity is exactly the assumption this exists to remove: it is right
 * today for classroom layers, which sit at the same origin, and it is right for
 * a reason nobody would restate when that stops being true.
 */
export type LayerFrameConversion = (point: { x: number; y: number }) => { x: number; y: number }

/** The identity, for two layers whose relative transform really is identity. */
export const sameFrame: LayerFrameConversion = point => point

/**
 * What to write into the destination for one shape.
 *
 * Identity is carried across deliberately: the same id, so the thing on the
 * other layer is the same annotation rather than a lookalike.
 *
 * Position is *converted*, not carried. A shape parented to its page has `x`
 * and `y` in its own layer's frame, and the destination's frame is a different
 * one; writing the same numbers puts the annotation wherever those numbers
 * happen to land over there. A shape nested inside another moved shape is
 * positioned relative to that parent, which is moving with it, so its offset is
 * already in the right frame and is left alone.
 *
 * `index` is dropped rather than carried. It orders a shape against its
 * siblings, and the siblings are different in the destination — a fractional
 * index from another room is meaningless there, and reusing it is how two
 * shapes end up claiming one position.
 */
export function shapeForDestination(
  shape: TLShape,
  destinationPageId: string,
  toDestinationFrame: LayerFrameConversion,
): Partial<TLShape> {
  const carried: Partial<TLShape> & { index?: unknown } = { ...shape }
  delete carried.index
  const { parentId, ...rest } = carried
  const nested = (parentId as string)?.startsWith('shape:')
  const placed = nested ? { x: shape.x, y: shape.y } : toDestinationFrame({ x: shape.x, y: shape.y })
  return {
    ...rest,
    x: placed.x,
    y: placed.y,
    // A shape parented to its page is re-parented to the destination's page.
    // One nested inside another moved shape keeps its parent, which is moving too.
    parentId: nested ? parentId : (destinationPageId as TLShape['parentId']),
  } as Partial<TLShape>
}

/**
 * Move shapes from one layer's store to another's.
 *
 * Returns the ids that moved. Throws `LayerMoveFailed` without deleting anything
 * if the destination did not take them.
 */
export function moveShapesToLayer(
  source: LayerStore,
  destination: LayerStore,
  ids: TLShapeId[],
  toDestinationFrame: LayerFrameConversion,
): TLShapeId[] {
  const shapes = ids.map(id => source.getShape(id)).filter((s): s is TLShape => Boolean(s))
  if (shapes.length === 0) return []

  const destinationPageId = destination.getCurrentPageId()
  destination.createShapes(shapes.map(shape => shapeForDestination(shape, destinationPageId, toDestinationFrame)))

  // Confirm before dropping. A store that silently rejected a record — a schema
  // it does not know, a parent it cannot find — reports nothing, and deleting on
  // that assumption is how a move becomes a loss.
  const missing = shapes.filter(shape => !destination.getShape(shape.id))
  if (missing.length > 0) {
    throw new LayerMoveFailed(
      `${missing.length} of ${shapes.length} annotations did not reach the other layer; nothing was removed`,
    )
  }

  source.deleteShapes(shapes.map(shape => shape.id))
  return shapes.map(shape => shape.id)
}

export class LayerCopyFailed extends Error {}

/**
 * Copy shapes onto another layer, leaving the originals where they are.
 *
 * Skip, 16:15:53 EDT: "And I guess we can expose, like, move and copy. Or will
 * move always be a copy?" The second half is his open question and this does not
 * answer it — move still moves. This is the other operation he named.
 *
 * **New ids, unlike a move.** A move carries the id across because the thing on
 * the other layer is the same annotation. A copy makes a second one, and two
 * annotations with one id is a collision waiting for someone to move either of
 * them into the other's room — where `createShapes` would land on top of an
 * existing record. The id factory is a parameter so the ordering stays testable
 * without a DOM, for the same reason `LayerStore` is.
 *
 * A shape nested inside another copied shape is re-parented to *its copy*, not
 * to the original it was nested in. Carrying the old parent id would leave the
 * copy pointing into the source room's tree.
 *
 * Same create → verify ordering as the move, minus the delete. Nothing is
 * removed here at all, so the worst reachable outcome is a copy that did not
 * arrive.
 */
export function copyShapesToLayer(
  source: LayerStore,
  destination: LayerStore,
  ids: TLShapeId[],
  makeId: () => TLShapeId,
  toDestinationFrame: LayerFrameConversion,
): TLShapeId[] {
  const shapes = ids.map(id => source.getShape(id)).filter((s): s is TLShape => Boolean(s))
  if (shapes.length === 0) return []

  const destinationPageId = destination.getCurrentPageId()
  const copiedId = new Map<TLShapeId, TLShapeId>(shapes.map(shape => [shape.id, makeId()]))

  destination.createShapes(shapes.map(shape => {
    const written = { ...shapeForDestination(shape, destinationPageId, toDestinationFrame) } as Record<string, unknown>
    written.id = copiedId.get(shape.id)
    const parent = written.parentId
    if (typeof parent === 'string' && parent.startsWith('shape:')) {
      // Nested inside another shape being copied → point at that shape's copy.
      // Nested inside something staying behind → it has no copy to belong to, so
      // the copy joins the destination's page rather than dangling.
      written.parentId = copiedId.get(parent as TLShapeId) ?? destinationPageId
    }
    return written as Partial<TLShape>
  }))

  const arrived = [...copiedId.values()]
  const missing = arrived.filter(id => !destination.getShape(id))
  if (missing.length > 0) {
    throw new LayerCopyFailed(
      `${missing.length} of ${shapes.length} annotations did not reach the other layer; nothing was changed`,
    )
  }

  return arrived
}

/**
 * The relative transform between two layers, as a point conversion.
 *
 * This is the one place a move or a copy learns where the destination frame is,
 * and it asks the WM rather than assuming. `wm.translate` is the primitive that
 * composes the two layers' effective transforms, so the answer stays right when
 * one layer moves relative to the next — which Skip named as the thing that is
 * allowed to happen: *"we can have problems with one layer moving relative to
 * the next, Wrong. But, like, shit in a layer stays in the fucking like, that's
 * crucial."*
 */
export function layerFrameConversion(
  wm: { translate(point: { x: number; y: number }, from: string, to: string): { x: number; y: number } },
  sourceLayerId: string,
  destinationLayerId: string,
): LayerFrameConversion {
  return point => wm.translate(point, sourceLayerId, destinationLayerId)
}

/** Narrow a tldraw Editor to what a move needs. */
export function layerStore(editor: Editor): LayerStore {
  return {
    getShape: id => editor.getShape(id),
    createShapes: shapes => editor.createShapes(shapes as Parameters<Editor['createShapes']>[0]),
    deleteShapes: ids => editor.deleteShapes(ids),
    getCurrentPageId: () => editor.getCurrentPageId(),
  }
}
