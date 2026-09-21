// A host predicate is an explicit contract, not a mode: when the caller names
// which shapes its pane shows, that predicate decides regardless of `readOnly`.
//
// The grading submission pane is the caller that needs this: it renders over the
// SAME editor/store it writes to, so `readOnly` is false (the pane takes draw
// input), but the pane must still show only the submitted page, its
// descendants, and this answer's marking layer. The old rule returned `undefined`
// — no filtering at all — whenever `readOnly` was false, which would put the
// whole workspace, solution pane included, in the submission pane.

export interface CanvasClipShapeLike {
  type: string
}

export function createCanvasClipShapePredicate<T extends CanvasClipShapeLike>({
  lockCamera,
  readOnly,
  hostShapePredicate,
}: {
  lockCamera: boolean
  readOnly: boolean
  hostShapePredicate?: (shape: T) => boolean
}): ((shape: T) => boolean) | undefined {
  if (!lockCamera && !readOnly && !hostShapePredicate) return undefined

  return (shape: T) => {
    if (hostShapePredicate) return hostShapePredicate(shape)
    if (lockCamera) return false
    return true
  }
}
