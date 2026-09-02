import type { Editor, TLShape, TLViewportId } from 'tldraw'
import { clientPointToPage } from './viewport-coordinates'
import { editorViewportLayerLookup, resolveContextLayer, type ContextLayerResolution } from './layer-context'
import { getEditorWMCore } from './editor-wm'
import type { LayerHit, LayerId } from './wm-core'

/**
 * The frame a gesture is happening in: which viewport projected it, and — the
 * part that was missing — **which layer that viewport draws into.**
 *
 * Skip, 2026-08-13 04:17:59 EDT: *"Obviously, the React context and the window
 * manager's registry have to agree"*. This is where they meet. The viewport id
 * comes from React, the layer comes from the WM registry, and the resolution
 * is carried on the frame so that every consumer of the gesture is working from
 * the same answer rather than each deciding for itself.
 *
 * `resolution` is kept rather than reduced to a layer id, because *no layer* and
 * *a layer we could not resolve* are different facts and a consumer has to be
 * able to tell them apart. Collapsing them is the seam: a component rendering
 * into a viewport the WM does not know would otherwise be handed the document
 * layer, which reads as agreement.
 */
export interface FleetInteractionFrame {
  viewportId?: TLViewportId
  resolution: ContextLayerResolution
  /** The layer this gesture is in, or null if its viewport is unregistered. */
  layerId: LayerId | null
}

export function fleetInteractionFrame(editor: Editor, viewportId?: TLViewportId): FleetInteractionFrame {
  const resolution = resolveContextLayer(viewportId, editorViewportLayerLookup(editor))
  return { viewportId, resolution, layerId: resolution.layerId }
}

/**
 * The frame for a caller that has no gesture context: a placement at fixed
 * screen coordinates, or a drop handled outside any projected panel.
 *
 * It is the old `getHudEditor() ? HUD : undefined` heuristic, kept exactly, and
 * moved to where it can be seen. Callers that *do* know their frame must not
 * use this — the point of naming it is that a reader can tell the two apart,
 * which is impossible when the guess is buried in a helper's default.
 */
export function frameFromHudPresence(
  editor: Editor,
  hudViewportId: TLViewportId,
  hudIsOpen: boolean,
): FleetInteractionFrame {
  return fleetInteractionFrame(editor, hudIsOpen ? hudViewportId : undefined)
}

export function fleetPointerPagePoint(
  editor: Editor,
  frame: FleetInteractionFrame,
  point: { x: number; y: number },
) {
  return clientPointToPage(editor, point, frame.viewportId)
}

export function fleetPointerEventPagePoint(
  editor: Editor,
  frame: FleetInteractionFrame,
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
) {
  return fleetPointerPagePoint(editor, frame, { x: event.clientX, y: event.clientY })
}

/**
 * The shapes under a gesture's point, decided in each shape's own layer.
 *
 * This is the interaction half of "shit in a layer stays in the layer". A hit
 * test that compares one page point against every candidate's page bounds is
 * asking whether two numbers match; when the candidates are in different layers
 * those numbers are measurements of different things, and the comparison
 * succeeds without meaning anything. `wm.hitTest` converts the probe point into
 * each candidate's layer first, so the hit is decided in the frame the shape
 * actually lives in.
 *
 * Returns nothing when the gesture's own layer is unresolved — an unregistered
 * viewport has no frame to probe from, and probing from the document layer
 * anyway is the guess this exists to refuse.
 */
export function fleetShapesUnderPointer(
  editor: Editor,
  frame: FleetInteractionFrame,
  pagePoint: { x: number; y: number },
  candidates: readonly TLShape[],
): LayerHit<TLShape>[] {
  if (!frame.layerId) return []
  const wm = getEditorWMCore(editor)
  return wm.hitTest(pagePoint, frame.layerId, candidates, shape => {
    const bounds = editor.getShapePageBounds(shape.id)
    return bounds ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } : null
  })
}
