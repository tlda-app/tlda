/**
 * The place-stack algebra, with no editor and no browser in it.
 *
 * Pure so it can be exercised directly, for the same reason `markdown-deps.mjs`
 * is pure: the rule here is the part worth checking, and it should not need a
 * served page to run. `placeStack.ts` holds the state and does the moving.
 *
 * Skip, 2026-08-11 04:50 EDT: "we maintain a place stack … can go forward and
 * back in. Like, a browser has that. Where a place is a document."
 */

export type Place = {
  documentId: string
  pageId: string
  camera: { x: number; y: number; z: number }
}

export type PlaceStack = { back: Place[]; forward: Place[] }

export const emptyPlaceStack: PlaceStack = { back: [], forward: [] }

/**
 * Record where the reader was, as they leave.
 *
 * A browser pushes an in-page anchor jump as its own history entry. Here that
 * would fill the stack with hops inside one Markdown document, and back would
 * stop being a way OUT of it — which is the complaint this exists to answer.
 * So a departure from the document already on top REPLACES that entry with the
 * newer view instead of stacking beside it, and back always lands in a
 * different document. That is `a place is a document` applied, not relaxed.
 */
export function departFrom(stack: PlaceStack, here: Place): PlaceStack {
  const top = stack.back[stack.back.length - 1]
  const back = top && top.documentId === here.documentId
    ? [...stack.back.slice(0, -1), here]
    : [...stack.back, here]
  // Going somewhere new abandons forward history, same as a browser.
  return { back, forward: [] }
}

/** Pop the destination for a back step, and the stack that remains. */
export function stepBack(stack: PlaceStack, departing: Place | null): { target: Place | null; next: PlaceStack } {
  const target = stack.back[stack.back.length - 1]
  if (!target) return { target: null, next: stack }
  return {
    target,
    next: {
      back: stack.back.slice(0, -1),
      forward: departing ? [...stack.forward, departing] : stack.forward,
    },
  }
}

/** The mirror of stepBack. */
export function stepForward(stack: PlaceStack, departing: Place | null): { target: Place | null; next: PlaceStack } {
  const target = stack.forward[stack.forward.length - 1]
  if (!target) return { target: null, next: stack }
  return {
    target,
    next: {
      back: departing ? [...stack.back, departing] : stack.back,
      forward: stack.forward.slice(0, -1),
    },
  }
}
