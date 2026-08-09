import type { Editor, TLShape, TLShapeId } from 'tldraw'

// Marking is drawing. Skip's words: "I can just sort of draw arrows and shit to
// be like I'm lining my argument with your argument." So a mark is an ordinary
// tldraw shape and an arrow between the panes is an ordinary tldraw arrow.
// Nothing here invents a drawing surface.
//
// What it adds is two answers the app cannot otherwise give: which marks belong
// to this student, and which have not been handed back yet.

const DRAFT = 'draft'

// Whose mark this is, is answered by whose block it hangs from. Skip, 26 June:
// "Anything whose target/anchor is the student block gets classified as feedback
// for that student submission... If you move the student submission block, its
// attached feedback moves with it."
//
// That is tldraw's parent/child relationship, so marks are parented to the
// submission rather than carrying an `attached` flag beside it. Moving the block
// moves them for free, and the question "is this mark this student's" has one
// answer instead of two that can disagree.
function isMarkOn(shape: TLShape, submissionShapeId: TLShapeId): boolean {
  return shape.parentId === submissionShapeId
}

function isUnreturned(shape: TLShape): boolean {
  return (shape.meta as Record<string, unknown> | undefined)?.[DRAFT] === true
}

/**
 * Marks on this student's submission that have not been returned to them.
 *
 * Read from the room, not from the app's in-memory draft set: that set lives
 * only in the tab that made the marks, so after a reload it is empty while the
 * shapes are still on the server flagged draft. Marking a class is not one
 * sitting.
 */
export function unreturnedMarks(editor: Editor, submissionShapeId: TLShapeId): TLShape[] {
  return editor.getCurrentPageShapes().filter(shape => isMarkOn(shape, submissionShapeId) && isUnreturned(shape))
}

/**
 * Hand this student's marks back, by clearing the same flag the app already
 * uses to mean "not shown to anyone else yet".
 *
 * Scoped to the one submission on purpose. Both panes live on one page, and a
 * mark he makes on his own solution is the common layer — the thing he writes
 * once for everybody — not this student's feedback. Returning everything drawn
 * would hand the whole class's annotations to whoever he marked last.
 *
 * Returns how many were released, so a caller can tell "returned six" from
 * "there was nothing to return" — different sentences to say to someone who has
 * just spent twenty minutes marking.
 */
export function returnMarks(editor: Editor, submissionShapeId: TLShapeId): number {
  const marks = unreturnedMarks(editor, submissionShapeId)
  if (!marks.length) return 0
  editor.updateShapes(marks.map(shape => ({
    id: shape.id,
    type: shape.type,
    meta: { ...shape.meta, [DRAFT]: false },
  })))
  return marks.length
}

// The editor only exists inside the document component, and the marking control
// sits outside it. The app already bridges that gap with window events —
// `tlda-navigate`, `fleet-open-doc` — so this uses the same idiom rather than
// threading an editor reference through the tree.

export const FRAME_PAIR_EVENT = 'classroom-frame-pair'
export const RETURN_MARKS_EVENT = 'classroom-return-marks'
export const MARKS_RETURNED_EVENT = 'classroom-marks-returned'

export function installReturnMarksBridge(editor: Editor, submissionShapeId: TLShapeId): () => void {
  const onReturn = () => {
    const count = returnMarks(editor, submissionShapeId)
    window.dispatchEvent(new CustomEvent(MARKS_RETURNED_EVENT, { detail: { count } }))
  }
  window.addEventListener(RETURN_MARKS_EVENT, onReturn)
  return () => window.removeEventListener(RETURN_MARKS_EVENT, onReturn)
}

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
