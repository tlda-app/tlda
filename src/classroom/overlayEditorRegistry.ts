// Which canvas is currently drawing each layer.
//
// A one-line map, extracted because the interesting behaviour is an ORDERING
// and an ordering is not visible by reading either call site.
//
// The overlays are keyed on `resetKey`, so changing chapter replaces them.
// tldraw runs a canvas's teardown from its own effect cleanup, which is not
// ordered against the replacement canvas's `onMount`. So these two arrive in
// either order:
//
//     register(next)     the new canvas says it is here
//     release(previous)  the old canvas says it is going
//
// A release that deletes whatever is under the key is correct in one order and
// destroys a live registration in the other — and the damage is silent, because
// the overlay it dropped is still mounted and still drawable. Everything that
// needs the editor then does nothing at all: no selection is ever seen on that
// layer, and move and copy are unreachable with no error to show for it.
//
// Passing the editor to the release makes it idempotent and order-independent,
// which is the property to have when you cannot order the two events. Skip, on
// why that is the general rule: "it's like the key to having like ok behavior
// is a messy environment."

export type OverlayEditors<Id, Editor> = ReadonlyMap<Id, Editor>

/** Record that `editor` is now drawing `id`. Replaces any earlier one. */
export function withOverlayEditor<Id, Editor>(
  current: OverlayEditors<Id, Editor>,
  id: Id,
  editor: Editor,
): OverlayEditors<Id, Editor> {
  if (current.get(id) === editor) return current
  const next = new Map(current)
  next.set(id, editor)
  return next
}

/**
 * Record that `editor` has gone from `id` — **only if it is still the one
 * registered.** A teardown that arrives after its replacement has registered
 * changes nothing.
 */
export function withoutOverlayEditor<Id, Editor>(
  current: OverlayEditors<Id, Editor>,
  id: Id,
  editor: Editor,
): OverlayEditors<Id, Editor> {
  if (current.get(id) !== editor) return current
  const next = new Map(current)
  next.delete(id)
  return next
}
