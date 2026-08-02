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
 * Undecidable with fewer than two pages, which returns 'y' — a single page has
 * no flow, and stacked is the arrangement every other document uses.
 */
export function documentFlowAxis(
  editor: Editor,
  getPageBounds: (editor: Editor) => { pageShapes: any[] } | null,
): Axis {
  const bounds = getPageBounds(editor)
  if (!bounds || bounds.pageShapes.length < 2) return 'y'
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
