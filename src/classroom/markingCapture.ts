// Whether a marking layer composited over a pane takes the pointer.
//
// Skip, asked whether the layer should capture everything or only marking:
// "yea" — capture while drawing, otherwise let pointer, selection and scroll
// reach the surface underneath. And on the boundary being wrong: "if we sont
// like it we'll change it."
//
// Its own module rather than a constant inside the overlay component, because
// it is the rule that decides whether the surface underneath stays usable, and
// a rule worth testing on its own should not need a DOM to reach.

/**
 * The tools that put a mark on the active layer, or take one off it.
 *
 * An allow-list, and the direction is the point. Most of this app's tools are
 * NOT mark-making — `text-select` selects text in the document, `browse`
 * interacts with the page, and `terminal`, `cluster`, `playback-frame` and the
 * `fleet-*` tools all act on the base. An exception-list captured every one of
 * them, and would have captured every tool added later too.
 *
 * Erasers belong here because they act on marks that live on this layer; an
 * eraser that passed through would erase the wrong thing.
 */
const MARK_MAKING_TOOLS = new Set(['draw', 'highlight', 'eraser', 'math-note', 'voice-note'])

/** Whether a composited marking layer takes the pointer for this tool. */
export function markingLayerCaptures(toolId: string): boolean {
  return MARK_MAKING_TOOLS.has(toolId)
}
