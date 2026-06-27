// Dismissal for the suggestion "hopper" (the floating tooltip listing a
// suggestion group's options). It is shown on hover of a `.suggestion-group`
// and was previously hidden ONLY on that element's `mouseleave`. On a
// voice+touch-first surface there is no reliable mouseleave when the user taps
// empty space or scrolls, so the hopper stuck on screen until they happened to
// hover another suggestion — which they often cannot do.
//
// This attaches the dismissal triggers that do NOT require a hover: tap-away
// (a pointerdown anywhere outside a `.suggestion-group`), scroll/wheel, and
// Escape. All listeners are capture-phase and observe-only (no preventDefault),
// so they fire even when a child stops propagation or when scrolling happens
// inside a nested chat container, and they never interfere with TLDraw's own
// pointer handling. Pure DOM — no React — so it is unit-testable in isolation.
//
// Returns a cleanup function that removes every listener; call it when the
// hopper hides (or the component unmounts).
export function attachHopperDismiss(dismiss, { doc = document, win = window } = {}) {
  const onPointerDown = (e) => {
    const t = e.target
    // A tap on a chip/✕ inside a group handles itself (pick/dismiss); a tap on
    // another group re-shows its own tip. Anything else is a tap-away.
    if (t && typeof t.closest === 'function' && t.closest('.suggestion-group')) return
    dismiss()
  }
  const onKey = (e) => { if (e.key === 'Escape') dismiss() }
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('scroll', dismiss, true)
  win.addEventListener('wheel', dismiss, { passive: true })
  doc.addEventListener('keydown', onKey, true)
  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('scroll', dismiss, true)
    win.removeEventListener('wheel', dismiss)
    doc.removeEventListener('keydown', onKey, true)
  }
}
