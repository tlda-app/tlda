import type { ClipBounds } from '../CanvasClipPanel'

export type FleetHudDefaultAnchor = {
  panOffset: number
  cameraY: number
}

/**
 * Where the HUD's camera sits when nothing has been saved.
 *
 * One axis is derived from the document and one is pinned to the screen, and
 * which is which is the whole difference between a paper and a talk. Skip: "the
 * default computation is based on the distance between nearest lines -- the
 * margin for the document and the near edge for the layout."
 *
 * Stacked pages: x is document-derived, so the layout keeps its place beside
 * the document; y pins the layout's top to a fixed height on screen, because you
 * move DOWN a paper and the HUD should stay with you.
 *
 * Pages side by side: transposed. y is document-derived, so the layout's bottom
 * edge sits a marginGap above the top of the slide and travels with it; x holds
 * the screen position it was anchored at, because you move ACROSS a talk. The
 * overlay layer already stops following the camera horizontally there, so the
 * offset computed once behaves as a screen pin from then on -- which is why the
 * expression for it is unchanged and only its meaning is.
 *
 * Both branches state the same rule: near edge of the layout, near edge of the
 * document, one marginGap between them. The stacked one says it as an offset
 * from the document's left, equivalent because the layout's right edge is placed
 * at docPageLeft - marginGap + layoutDx. The transposed one says it in terms of
 * the layout's own bounds, which additionally self-heals a layout whose shapes
 * were placed before the transposition existed and still sit in a stale lane.
 */
export function computeFleetHudDefaultAnchor({
  bounds,
  docPageLeft,
  docLeftScreen,
  docTopScreen,
  layoutDx,
  topPad,
  marginGap,
  pagesFlowAcross,
}: {
  bounds: ClipBounds
  docPageLeft: number
  docLeftScreen: number
  docTopScreen: number
  layoutDx: number
  topPad: number
  marginGap: number
  pagesFlowAcross: boolean
}): FleetHudDefaultAnchor {
  return {
    panOffset: docLeftScreen - docPageLeft - layoutDx,
    cameraY: pagesFlowAcross
      ? docTopScreen - marginGap - (bounds.y + bounds.h)
      : topPad - bounds.y,
  }
}
