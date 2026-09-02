// Where the fleet layout sits across the document's flow.
//
// One line of arithmetic, extracted because the two cases are not variations of
// each other and the difference is invisible written as a ternary at the call
// site — which is how a deck ended up with every panel off the top of the
// screen while the expression looked symmetric.

import type { Axis } from './document-flow-axis'

/**
 * The near edge of the layout band, on the axis across the document's flow.
 *
 * **Beside (`marginAxis === 'x'`, a paper):** the band sits OUTSIDE the
 * document's near edge — its far edge is `marginGap` before the document
 * starts, so the two never overlap. A down-flowing paper leaves width at its
 * side and the viewport is wide enough to show it.
 *
 * **Along (`marginAxis === 'y'`, a deck):** the band sits INSIDE the top edge.
 * A deck runs across, so the margin across its flow is above it — and a deck
 * fills the viewport's height, so anything placed above the top edge is off
 * screen entirely. Measured on pic-dev before this: every HUD panel at
 * `bottom <= -55`, x correct, wholly above the view.
 *
 * Skip: *"having fleet shapes run along the top of decks like really helps me
 * write decks."* The band overlaps the slide, which is what an overlay does
 * when the document leaves it no margin, and it is the only way "along the top"
 * is reachable on a document that is 59,340 x 1,000.
 */
export function layoutAcrossOrigin({
  marginAxis,
  docNear,
  marginGap,
  contentAcross,
}: {
  marginAxis: Axis
  /** The document's near edge on the margin axis: minLeft beside, minTop along. */
  docNear: number
  marginGap: number
  /** The layout's extent on the margin axis. */
  contentAcross: number
}): number {
  return marginAxis === 'x'
    ? docNear - marginGap - contentAcross
    : docNear + marginGap
}
