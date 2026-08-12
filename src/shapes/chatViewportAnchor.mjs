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
 */
export function shouldPreserveChatViewport({ scrolledUp, hardLocked, hasAnchor }) {
  return scrolledUp === true && hardLocked !== true && hasAnchor === true
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
}) {
  if (!shouldPreserveChatViewport({ scrolledUp, hardLocked, hasAnchor })) {
    return { scrollTop, scrollHeight, scrollVelocity, delta: 0, preserved: false }
  }
  const delta = currentAnchorTop - anchorTop
  return {
    scrollTop: scrollTop + delta,
    scrollHeight,
    scrollVelocity,
    delta,
    preserved: Math.abs(delta) > 0.5,
  }
}
