import type { Editor, TLShapeId } from 'tldraw'

// Bringing both panes of the marking view into view.
//
// This file used to also decide which marks were "unreturned" and release them,
// by way of a `meta.draft` flag and a parent/child relationship to the
// submission block. Neither ever held: `draft` is stamped only in presentation
// mode, and tldraw parents a drawn shape to the page rather than to a non-frame
// shape, so both tests were false for every mark the app actually made.
//
// Withholding is now a layer — a sync room the student cannot enter — and
// returning is `moveShapesToLayer` from that room into the submission's. See
// `shared/classroom-rooms.mjs` and `moveBetweenLayers.ts`.

export const FRAME_PAIR_EVENT = 'classroom-frame-pair'

/**
 * Bring both panes into view after moving to a problem.
 *
 * Navigating to an anchor centres one shape, because in a single document that
 * is what it means. Here there are two, so it centred the submission and pushed
 * his own solution off the right edge — headings cut mid-word, on the surface
 * where he is comparing them.
 *
 * A pan, deliberately, not a zoom-to-fit: the pair already fits at the current
 * zoom, and rescaling would shrink his solution every time he changed problem.
 * Vertical position is left exactly as navigation set it, since that is the
 * part that put the right problem on screen.
 */
export function framePair(editor: Editor, shapeIds: TLShapeId[]): boolean {
  const bounds = shapeIds
    .map(id => editor.getShapePageBounds(id))
    .filter((b): b is NonNullable<typeof b> => !!b)
  if (bounds.length < 2) return false

  const left = Math.min(...bounds.map(b => b.x))
  const right = Math.max(...bounds.map(b => b.x + b.w))
  const camera = editor.getCamera()
  const viewportWidth = editor.getViewportScreenBounds().w
  // screen = (page + camera) * z, so centring the pair's midpoint is one solve.
  const midpoint = (left + right) / 2
  editor.setCamera({ ...camera, x: viewportWidth / (2 * camera.z) - midpoint })
  return true
}

export function installFramePairBridge(editor: Editor, shapeIds: TLShapeId[]): () => void {
  const onFrame = () => framePair(editor, shapeIds)
  window.addEventListener(FRAME_PAIR_EVENT, onFrame)
  return () => window.removeEventListener(FRAME_PAIR_EVENT, onFrame)
}
