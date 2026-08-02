import type { ClipBounds } from '../CanvasClipPanel'
import { crossAxis, type Axis } from '../shapes/document-flow-axis'

export type FleetHudDefaultAnchor = {
  panOffset: number
  cameraY: number
}

/**
 * Where the HUD's camera sits.
 *
 * Skip: "the shapes on the HUD are in a fixed position relative to the fucking
 * screen in one direction and the slides in the other. Right? Like so it's not
 * a hack. It's just the fucking rule."
 *
 * In one sentence with no document type in it: **screen-fixed along the axis the
 * pages flow, document-fixed across it.**
 *
 * - Along the flow: the layout's near edge sits `screenPad` from the edge of the
 *   screen and stays there while you move through the document. You travel on
 *   this axis, so the HUD has to hold still on it.
 * - Across the flow: the layout's far edge sits `marginGap` before the
 *   document's near edge, projected to screen — it lives in the margin and moves
 *   with the document. Skip: "the distance between nearest lines — the margin for
 *   the document and the near edge for the layout."
 *
 * A paper flows down, so it is screen-fixed vertically and rides in the side
 * margin. A deck flows across, so it is screen-fixed horizontally and rides in
 * the margin above. Both are this function with a different axis; neither is a
 * case, and there is no branch on which kind of document it is.
 *
 * Every term is read off the layout's own bounds, which is what lets it place a
 * layout whose shapes are somewhere unexpected rather than trusting a stored
 * number to still mean what it meant when it was written.
 */
export function computeFleetHudDefaultAnchor({
  bounds,
  docNearScreen,
  flowAxis,
  screenPad,
  marginGap,
}: {
  bounds: ClipBounds
  /** The document's near edge on the margin axis, projected to screen. */
  docNearScreen: number
  flowAxis: Axis
  screenPad: number
  marginGap: number
}): FleetHudDefaultAnchor {
  const marginAxis = crossAxis(flowAxis)
  const alongFlow = screenPad - (flowAxis === 'x' ? bounds.x : bounds.y)
  const acrossFlow = docNearScreen - marginGap - (marginAxis === 'x'
    ? bounds.x + bounds.w
    : bounds.y + bounds.h)
  return {
    panOffset: flowAxis === 'x' ? alongFlow : acrossFlow,
    cameraY: flowAxis === 'y' ? alongFlow : acrossFlow,
  }
}
