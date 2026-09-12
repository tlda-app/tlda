// Which two editors a return is allowed to move between.
//
// Its own module, and dependency-free, so the rule can be tested without a DOM.
// The rule embedded in the component could only be exercised by driving a
// browser, and both failures it guards against were found in a browser after
// passing a unit test that could not express them.
//
// Two measured failures, not hypotheticals:
//
// Pressing Return re-renders, the draft overlay is replaced, and a handler that
// captured the editor at render time deleted from a DISPOSED editor. Silently —
// and it reported success, because the dead editor's last store state still
// listed the marks. Reading the live ends at move time is the repair. Why the
// remount happens is not established, and this does not depend on knowing: any
// replacement, from any cause, is handled the same way.
//
// And the same shape of bug with a worse outcome: flicking to the next student
// while the request is in flight would record one student's return and publish
// the marks onto another student's work. So "still mounted" is not the question
// — "still THIS student's" is, which is why the room travels with each editor.

export interface ReturnEnd<TEditor> {
  editor: TEditor
  /** The room this editor was mounted for, not the room now on screen. */
  roomId: string
}

/**
 * What a held end becomes when some editor reports that it is going.
 *
 * Clearing on teardown without checking WHICH editor went is a live-reference
 * bug, not a tidy-up: a remount runs the old editor's teardown **after** the
 * replacement has registered, so an unconditional clear erases the editor that
 * is actually on screen. The room cannot tell them apart — the old and new
 * editors are in the same room — so identity is the only thing that can.
 */
export function releaseHeldEnd<TEditor>(
  held: ReturnEnd<TEditor> | null,
  released: TEditor,
): ReturnEnd<TEditor> | null {
  if (!held || held.editor !== released) return held
  return null
}

/**
 * The live source and destination, or `null` if the return must not proceed.
 *
 * `null` means fail closed: the server half is already recorded, so the caller
 * reports the marks as unpublished and leaves them private. That is
 * recoverable — press Return again on the right student — where publishing to
 * the wrong room is not.
 */
export function resolveReturnEnds<TEditor>({
  draft,
  destination,
  intendedRoomId,
}: {
  draft: ReturnEnd<TEditor> | null
  destination: ReturnEnd<TEditor> | null
  intendedRoomId: string
}): { draft: TEditor; destination: TEditor } | null {
  if (!draft || !destination) return null
  // BOTH ends. The destination can be replaced exactly as the draft layer can,
  // so checking one would leave the other stale.
  if (draft.roomId !== intendedRoomId || destination.roomId !== intendedRoomId) return null
  return { draft: draft.editor, destination: destination.editor }
}
