import type { Editor, TLShape } from 'tldraw'
import { isMyFleetShape } from './fleet-ownership'

export type WrapDocumentBounds = { x: number; y: number; w: number; h: number }

export type FleetLayoutWrapPanel = { id: string; x: number; y: number; w: number }

export type FleetLayoutWrapPlan = {
  /** How far the document's left edge moved. The camera translates by this. */
  dx: number
  /** How far the document's top edge moved. */
  dy: number
  moves: Array<{ id: string; x: number; y: number }>
}

/**
 * Plan the layout's move from one document to another.
 *
 * A panel's position is an offset from the document's edges, and that offset is
 * what survives navigation: a panel in the left margin keeps its distance from
 * the new document's LEFT edge, a panel in the right margin keeps its distance
 * from the new document's RIGHT edge. Two documents of different widths pull
 * those two margins apart, which is why the edge is what is preserved and not
 * the screen position.
 *
 * Vertically every panel moves with the top edge. A document's bottom is where
 * its page stack happens to end, not a margin.
 *
 * Same document in and out: every delta is zero and the plan is empty. The
 * no-op falls out of the rule; it is not a branch on document identity.
 */
export function planFleetLayoutWrap({
  panels,
  source,
  target,
}: {
  panels: FleetLayoutWrapPanel[]
  source: WrapDocumentBounds
  target: WrapDocumentBounds
}): FleetLayoutWrapPlan {
  const dx = target.x - source.x
  const dxRight = target.x + target.w - (source.x + source.w)
  const dy = target.y - source.y
  const sourceCenterX = source.x + source.w / 2
  const moves: FleetLayoutWrapPlan['moves'] = []
  for (const panel of panels) {
    const panelDx = panel.x + panel.w / 2 <= sourceCenterX ? dx : dxRight
    if (panelDx === 0 && dy === 0) continue
    moves.push({ id: panel.id, x: panel.x + panelDx, y: panel.y + dy })
  }
  return { dx, dy, moves }
}

/**
 * Move this device's fleet panels so they wrap around `target` the way they
 * wrapped around `source`. Layout bookkeeping rather than a document edit, so
 * it stays off the undo stack like every other write to fleet layout state.
 */
export function wrapFleetLayoutAroundDocument(
  editor: Editor,
  source: WrapDocumentBounds,
  target: WrapDocumentBounds,
): FleetLayoutWrapPlan {
  const shapes = new Map<string, TLShape>()
  const panels: FleetLayoutWrapPanel[] = []
  for (const shape of editor.getCurrentPageShapes()) {
    if (!isMyFleetShape(shape)) continue
    const bounds = editor.getShapePageBounds(shape.id)
    if (!bounds) continue
    shapes.set(shape.id, shape)
    panels.push({ id: shape.id, x: shape.x, y: shape.y, w: bounds.w })
  }
  const plan = planFleetLayoutWrap({ panels, source, target })
  if (plan.moves.length > 0) {
    editor.run(() => {
      editor.updateShapes(plan.moves.map(move => ({
        id: move.id as TLShape['id'],
        type: shapes.get(move.id)!.type,
        x: move.x,
        y: move.y,
      })))
    }, { history: 'ignore' })
  }
  return plan
}
