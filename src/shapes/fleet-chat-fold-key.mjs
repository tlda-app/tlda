// The remembered-expansion key for a thread card's gap marker or its hidden
// rows. Both halves of the pair carry the same `data-fold-id`, so the click
// that expands and the restore that re-expands after a re-render name the same
// thing without either of them counting siblings.
//
// They used to count: the click indexed the button among the row's
// `.pretty-expand-btn`, the restore indexed the rows among the view's
// `.pretty-more-rows`, and the two agreed only while a row held exactly one
// expand button. A thread whose front rows contain a search activity renders a
// second one, so the marker was written under `:pretty:1` and read back under
// `:pretty:0` -- remembered, then never found again, which is the card growing
// and collapsing a frame later.
//
// The card's own semantic key qualifies it so two thread cards merged into one
// chat row do not share a fold. The positional fallback is for markup that
// predates the attribute.
export function prettyFoldKey(itemKey, el, fallbackIndex) {
  const foldId = el.dataset?.foldId
  if (!foldId) return `${itemKey}:pretty:${fallbackIndex}`
  const card = el.closest('.semantic-operation-body')
  const semanticKey = card?.dataset?.semanticKey || ''
  return `${itemKey}:pretty:${semanticKey}:${foldId}`
}
