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
 * What to write into the destination for one shape.
 *
 * Identity and position are carried across deliberately: the same id, so the
 * thing on the other layer is the same annotation rather than a lookalike, and
 * the same page coordinates, so it does not appear to jump. The layers share a
 * camera, so page coordinates mean the same thing in both.
 *
 * `index` is dropped rather than carried. It orders a shape against its
 * siblings, and the siblings are different in the destination — a fractional
 * index from another room is meaningless there, and reusing it is how two
 * shapes end up claiming one position.
 */
export function shapeForDestination(shape: TLShape, destinationPageId: string): Partial<TLShape> {
  const carried: Partial<TLShape> & { index?: unknown } = { ...shape }
  delete carried.index
  const { parentId, ...rest } = carried
  return {
    ...rest,
    // A shape parented to its page is re-parented to the destination's page.
    // One nested inside another moved shape keeps its parent, which is moving too.
    parentId: (parentId as string)?.startsWith('shape:') ? parentId : (destinationPageId as TLShape['parentId']),
  } as Partial<TLShape>
}

/**
 * Move shapes from one layer's store to another's.
 *
 * Returns the ids that moved. Throws `LayerMoveFailed` without deleting anything
 * if the destination did not take them.
 */
export function moveShapesToLayer(source: LayerStore, destination: LayerStore, ids: TLShapeId[]): TLShapeId[] {
  const shapes = ids.map(id => source.getShape(id)).filter((s): s is TLShape => Boolean(s))
  if (shapes.length === 0) return []

  const destinationPageId = destination.getCurrentPageId()
  destination.createShapes(shapes.map(shape => shapeForDestination(shape, destinationPageId)))

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

/** Narrow a tldraw Editor to what a move needs. */
export function layerStore(editor: Editor): LayerStore {
  return {
    getShape: id => editor.getShape(id),
    createShapes: shapes => editor.createShapes(shapes as Parameters<Editor['createShapes']>[0]),
    deleteShapes: ids => editor.deleteShapes(ids),
    getCurrentPageId: () => editor.getCurrentPageId(),
  }
}
