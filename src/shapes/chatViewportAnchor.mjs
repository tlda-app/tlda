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

export function shouldPrefetchEarlierChatHistory({ top, viewportHeight }) {
  return Number.isFinite(top)
    && Number.isFinite(viewportHeight)
    && viewportHeight > 0
    && top <= viewportHeight
}

export function nextEarlierChatHistoryWindow(current, initial, maximum = 500) {
  const floor = Math.max(1, Number(initial) || 1)
  const size = Math.max(floor, Number(current) || floor)
  return Math.min(maximum, size * 2)
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

/**
 * Scroll restoration across reload.
 *
 * A reader scrolled up to a card who reloads lands at the tail: the list
 * mounts empty and its first population unconditionally scrolls there, so the
 * card they were looking at is gone from where they were looking. Live keeps
 * the reader where they were; reload did not, which is the asymmetry Skip
 * reported as delegate cards missing from history.
 *
 * The persisted state is an ANCHOR, not a pixel offset: the key of the topmost
 * visible item plus the offset into it. A raw modelTop is meaningless against
 * a different item set, while an anchor either names a row on screen or names
 * nothing — and nothing restores to the tail, which is the current behaviour.
 * The filter key rides along so a filter change never restores a stale
 * position from a different conversation.
 */
export const CHAT_SCROLL_STORE_VERSION = 1

export function chatScrollStoreKey(panelId) {
  return `tlda:chat-scroll:v1:${String(panelId || '')}`
}

// The topmost item intersecting modelTop: the row the reader's viewport starts
// in. `heightOf` resolves measured-or-estimated heights the same way the list
// geometry does. Null when no row intersects, which is the tail case the
// caller records as tail rather than as an anchor.
export function anchorChatScrollPosition(keys, heightOf, modelTop) {
  if (!Array.isArray(keys) || keys.length === 0) return null
  if (!Number.isFinite(modelTop) || modelTop < 0) return null
  let cursor = 0
  for (const key of keys) {
    const h = heightOf(key)
    const height = Number.isFinite(h) && h > 0 ? h : 0
    if (cursor + height > modelTop) {
      return { anchorKey: String(key), anchorOffset: modelTop - cursor }
    }
    cursor += height
  }
  return null
}

// The accumulated start of one key under the same walk the list geometry
// builds its `starts` map from. Null when the key is not in this item set,
// which is a page that does not contain the anchor.
export function chatScrollStartOf(keys, heightOf, anchorKey) {
  if (!Array.isArray(keys) || typeof anchorKey !== 'string' || !anchorKey) return null
  let cursor = 0
  for (const key of keys) {
    if (String(key) === anchorKey) return cursor
    const h = heightOf(key)
    cursor += Number.isFinite(h) && h > 0 ? h : 0
  }
  return null
}

// Where a saved state puts the reader, or null for "the tail, as today".
// Null covers: no record, a version bump, a filter change, an explicit tail
// record, a malformed record, and an anchor whose row is not on screen.
export function resolveChatScrollRestore(saved, resetKey, startOf) {
  if (!saved || typeof saved !== 'object') return null
  if (saved.v !== CHAT_SCROLL_STORE_VERSION) return null
  if (typeof saved.filterKey !== 'string' || saved.filterKey !== resetKey) return null
  if (saved.tail === true) return null
  if (typeof saved.anchorKey !== 'string' || !saved.anchorKey) return null
  if (!Number.isFinite(saved.anchorOffset) || saved.anchorOffset < 0) return null
  const start = startOf(saved.anchorKey)
  if (!Number.isFinite(start) || start < 0) return null
  return start + saved.anchorOffset
}

export function readChatScrollState(storage, key) {
  try {
    const raw = storage?.getItem?.(key)
    if (typeof raw !== 'string' || !raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function writeChatScrollState(storage, key, state) {
  try {
    storage?.setItem?.(key, JSON.stringify(state))
    return true
  } catch {
    return false
  }
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
