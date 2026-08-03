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
  screen,
}: {
  bounds: ClipBounds
  /** The document's near edge on the margin axis, projected to screen. */
  docNearScreen: number
  flowAxis: Axis
  screenPad: number
  marginGap: number
  /** The viewport the HUD draws into, for the on-screen guarantee below. */
  screen: { w: number; h: number }
}): FleetHudDefaultAnchor {
  const marginAxis = crossAxis(flowAxis)
  const alongFlow = screenPad - (flowAxis === 'x' ? bounds.x : bounds.y)
  const acrossFlow = docNearScreen - marginGap - (marginAxis === 'x'
    ? bounds.x + bounds.w
    : bounds.y + bounds.h)

  // The margin is where the layout WANTS to be. Being on screen is what it has
  // to be. Skip: "you also make a layout that actually works on a slideshow...
  // right now, have shit off my screen."
  //
  // A document only leaves a usable margin if it doesn't fill the viewport
  // across its flow. A portrait page doesn't, so a paper's layout sits beside it
  // and this changes nothing. A slide fills the screen, so the margin above it is
  // off the top — the rule is satisfied and the layout is invisible, which is not
  // a layout. So: place by the rule, then move the least amount that brings it
  // back on screen. Same sentence for both, and the margin still wins whenever
  // there is room for it.
  const onScreen = (offset: number, near: number, size: number, screenSize: number) => {
    const lo = screenPad - near                          // near edge at the pad
    const hi = screenSize - screenPad - (near + size)    // far edge at the pad
    if (lo < hi) return Math.min(Math.max(offset, hi), lo)
    return lo                                            // taller than the screen: show the near edge
  }

  return {
    panOffset: onScreen(flowAxis === 'x' ? alongFlow : acrossFlow, bounds.x, bounds.w, screen.w),
    cameraY: onScreen(flowAxis === 'y' ? alongFlow : acrossFlow, bounds.y, bounds.h, screen.h),
  }
}
