/**
 * Viewport preservation for chat reader mode.
 *
 * Skip's invariant: "it's not just, like, nothing changes on your screen when
 * new messages arrive. That includes when it's static. That includes when
 * you're scrolling. The feel of scrolling also doesn't change when new messages
 * arrive. It's just the distance you have to scroll changes. That's the fucking
 * rule."
 *
 * So input state is deliberately not part of this decision. A gesture decides
 * whether the reader is off the tail; it does not authorize message arrival or
 * row measurement to move the visible content.
 *
 * That is two questions and they have different answers. WHETHER the reader's
 * position is preserved never depends on input — the rule above. WHEN the
 * correction may be written to `scrollTop` does, because the scroller is not
 * ours while a gesture is in flight: a momentum glide is driven by the
 * compositor, and writing `scrollTop` mid-glide fights it frame by frame
 * instead of holding a position. Collapsing the two is what deleted the touch
 * guard in `7430200ad` and put a jitter under Skip's finger on his phone.
 */
export function shouldPreserveChatViewport({ scrolledUp, hardLocked, hasAnchor }) {
  return scrolledUp === true && hardLocked !== true && hasAnchor === true
}

export function anchoredTailTop({ renderedLastRowTop, renderedLastRowHeight, viewportHeight, fallbackTotal }) {
  const hasRenderedTail = Number.isFinite(renderedLastRowTop) && Number.isFinite(renderedLastRowHeight)
  const contentBottom = hasRenderedTail
    ? renderedLastRowTop + renderedLastRowHeight
    : fallbackTotal
  return Math.max(0, contentBottom - viewportHeight)
}

export function anchoredSensorTailTop(scrollHeight, clientHeight) {
  return Math.max(0, scrollHeight - clientHeight)
}

/**
 * True while the reader's own input owns the scroller, so a geometry correction
 * must be deferred rather than written.
 *
 * `touchScrollActive` spans the whole finger-driven scroll — touchdown through
 * the momentum glide that outlives the release, until the scroller goes quiet.
 * That window, not "a pointer is currently down", is the one that matters: an
 * iOS glide runs with the finger already lifted, which is why a pointer-held
 * guard recorded one deferral against 211 corrections in Skip's session.
 *
 * One definition, so the reconcile path and the scroll path cannot drift into
 * two notions of "input in flight".
 */
export function isReaderInputInFlight({
  touchScrollActive,
  explicitScrollInput,
  pointerHeldInPanel,
} = {}) {
  return touchScrollActive === true
    || explicitScrollInput === true
    || pointerHeldInPanel === true
}

export function preserveChatViewportAcrossArrival({
  scrollTop,
  scrollHeight,
  anchorTop,
  currentAnchorTop,
  scrolledUp,
  hardLocked,
  hasAnchor,
  scrollVelocity = 0,
  touchScrollActive,
  explicitScrollInput,
  pointerHeldInPanel,
}) {
  if (!shouldPreserveChatViewport({ scrolledUp, hardLocked, hasAnchor })) {
    return { scrollTop, scrollHeight, scrollVelocity, delta: 0, preserved: false, deferred: false }
  }
  // The anchor is still held and still owed a correction; only the write waits.
  // Deferring is not declining to preserve the viewport, which is why this
  // returns the position unchanged rather than a delta of zero.
  if (isReaderInputInFlight({ touchScrollActive, explicitScrollInput, pointerHeldInPanel })) {
    return { scrollTop, scrollHeight, scrollVelocity, delta: 0, preserved: false, deferred: true }
  }
  const delta = currentAnchorTop - anchorTop
  return {
    scrollTop: scrollTop + delta,
    scrollHeight,
    scrollVelocity,
    delta,
    preserved: Math.abs(delta) > 0.5,
    deferred: false,
  }
}
