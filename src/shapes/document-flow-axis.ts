import type { Editor } from 'tldraw'

/**
 * The axis a document's pages run along, and the rule that everything about
 * HUD placement is stated in.
 *
 * Skip: "the shapes on the HUD are in a fixed position relative to the fucking
 * screen in one direction and the slides in the other. Right? Like so it's not
 * a hack. It's just the fucking rule."
 *
 * So: **screen-fixed along the flow axis, document-fixed across it.** A paper
 * runs down the canvas, so its HUD holds a height on screen and lives in the
 * side margin. A deck runs across, so its HUD holds a horizontal position on
 * screen and lives in the margin above. One sentence, and neither a paper nor a
 * talk appears in it -- there is no document type here, only a flow direction.
 *
 * Read off the pages themselves rather than a format string: anything that
 * arranges pages the same way behaves the same way without being named.
 */
export type Axis = 'x' | 'y'

/** How much wider than tall a single page must be to count as running across.
 *  Deliberately well above 1: a page a little wider than tall is a page, not a
 *  strip. A deck of N slides is N × 1.5 slide-widths wide by one tall. */
const FLOW_ASPECT = 3

/** The axis at right angles to `axis`. Not a branch on document type — the
 *  complement of a direction is arithmetic. */
export function crossAxis(axis: Axis): Axis {
  return axis === 'x' ? 'y' : 'x'
}

/** The size of a box along `axis`. */
export function sizeAlong(box: { w: number; h: number }, axis: Axis): number {
  return axis === 'x' ? box.w : box.h
}

/** The near (minimum) coordinate of a box along `axis`. */
export function minAlong(box: { x: number; y: number }, axis: Axis): number {
  return axis === 'x' ? box.x : box.y
}

/**
 * Which way this document's pages run.
 *
 * With fewer than two pages the spread says nothing, so the page's OWN shape
 * does: a box far wider than it is tall runs across. That is not a special case
 * for decks — it is the same question asked of one box instead of many, and it
 * is what a deck now needs, because a deck is ONE page shape carrying every
 * slide rather than one shape per slide.
 *
 * Measured when this was missing: a deck at 59,340 × 1,000 answered 'y', so the
 * HUD placed fleet shapes down the side of a document that runs across — they
 * landed tens of thousands of px below a 1,000px slide.
 *
 * A genuinely square or tall single page still returns 'y', which is the old
 * answer and the arrangement every other document uses.
 */
export function documentFlowAxis(
  editor: Editor,
  getPageBounds: (editor: Editor) => { pageShapes: any[] } | null,
): Axis {
  const bounds = getPageBounds(editor)
  if (!bounds || bounds.pageShapes.length === 0) return 'y'
  if (bounds.pageShapes.length < 2) {
    const only = editor.getShapePageBounds(bounds.pageShapes[0].id)
    return only && only.w > only.h * FLOW_ASPECT ? 'x' : 'y'
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const ps of bounds.pageShapes) {
    const b = editor.getShapePageBounds(ps.id)
    if (!b) continue
    if (b.x < minX) minX = b.x
    if (b.x > maxX) maxX = b.x
    if (b.y < minY) minY = b.y
    if (b.y > maxY) maxY = b.y
  }
  if (!isFinite(minX) || !isFinite(minY)) return 'y'
  return (maxX - minX) > (maxY - minY) ? 'x' : 'y'
}
