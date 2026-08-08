import type { Editor, TLShape, TLShapeId } from 'tldraw'

// Marking is drawing. Skip's words: "I can just sort of draw arrows and shit to
// be like I'm lining my argument with your argument." So a mark is an ordinary
// tldraw shape on the student's submission, and an arrow between the two panes
// is an ordinary tldraw arrow. Nothing here invents a drawing surface.
//
// What it does add is the answer to "which of these have I not sent back yet",
// and it deliberately does not use the app's in-memory draft set to answer it.
// That set (annotationVisibility.draftIds) lives only in the tab that made the
// marks: reload, and it is empty while the shapes are still on the server
// flagged draft. Marking a class is not a single sitting, so the question has
// to be answered from the room, which survives.

const DRAFT = 'draft'

function isUnreturnedMark(shape: TLShape, pageShapeIds: ReadonlySet<TLShapeId>): boolean {
  if (pageShapeIds.has(shape.id)) return false        // the document pages themselves
  return (shape.meta as Record<string, unknown> | undefined)?.[DRAFT] === true
}

/**
 * Every mark on this submission that has not been returned to the student,
 * read from the room rather than from tab memory.
 */
export function unreturnedMarks(editor: Editor, pageShapeIds: ReadonlySet<TLShapeId> = new Set()): TLShape[] {
  return editor.getCurrentPageShapes().filter(shape => isUnreturnedMark(shape, pageShapeIds))
}

/**
 * Hand this student's marks back: the same flag the app already uses to mean
 * "not yet shown to anyone else", cleared.
 *
 * Returns how many were released, so a caller can tell the difference between
 * "returned six marks" and "there was nothing to return" — which are different
 * things to say to someone who has just spent twenty minutes marking.
 */
export function returnMarks(editor: Editor, pageShapeIds: ReadonlySet<TLShapeId> = new Set()): number {
  const marks = unreturnedMarks(editor, pageShapeIds)
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

export const RETURN_MARKS_EVENT = 'classroom-return-marks'
export const MARKS_RETURNED_EVENT = 'classroom-marks-returned'

export function installReturnMarksBridge(editor: Editor, pageShapeIds: ReadonlySet<TLShapeId>): () => void {
  const onReturn = () => {
    const count = returnMarks(editor, pageShapeIds)
    window.dispatchEvent(new CustomEvent(MARKS_RETURNED_EVENT, { detail: { count } }))
  }
  window.addEventListener(RETURN_MARKS_EVENT, onReturn)
  return () => window.removeEventListener(RETURN_MARKS_EVENT, onReturn)
}
