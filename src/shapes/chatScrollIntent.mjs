// chatScrollIntent — the single source of truth for "is the user following the
// tail, or reading history?" Extracted as a pure function so it can be unit
// tested deterministically (the bug was an emergent interaction that browser
// tests reproduce flakily; the *decision* is what must be provably correct).
//
// Intent comes ONLY from a scrollTop delta the content didn't cause. A height
// change (render-window resize, in-place growth) moves `gap` and can clamp
// scrollTop without the user touching anything, so BOTH transitions gate on a
// real directional move with no simultaneous height change.

export const FOLLOW_BOTTOM_EPS = 120 // absorbs the ~40px status footer below the last data item
// Measured, not guessed. 24 hours of follow-off records from a live session:
// genuine scroll-ups are moves over 20px that leave the bottom (129 of 155),
// while what dropped the reader off follow was a 5-to-8 pixel drift with the
// content height unchanged — the virtualizer and the browser settling scroll
// position. At 4px this sat below the noise floor of the thing it measures.
export const UP_JITTER_EPS = 20
export const TRUE_BOTTOM_EPS = 8

/**
 * @param {{top:number, height:number, clientHeight:number, lastTop:number, lastHeight:number}} sample
 *   top/height = current scrollTop/scrollHeight; lastTop/lastHeight = previous event's values.
 * @param {{scrolledUp:boolean, hardLocked:boolean, geometryReconciliation:boolean}} state
 *   scrolledUp = reader mode; hardLocked = forced-follow; geometryReconciliation
 *   marks the one layout seam preserving that mode.
 * @returns {{scrolledUp:boolean, action:'follow-off'|'follow-on'|'none'}}
 */
export function decideFollowTransition(sample, state) {
  const { top, height, clientHeight, lastTop, lastHeight } = sample
  const gap = height - top - clientHeight
  const heightStable = Math.abs(height - lastHeight) <= 2

  // up-scroll: top fell past the jitter eps while content height stayed fixed.
  // A resize can shift scrollTop in either direction without reader input.
  // ...and it has to actually leave the bottom. You cannot scroll up and still
  // be at the bottom: 386 of the 1045 recorded follow-offs left the reader at or
  // PAST it, one as far as gap -187, which is not a position anyone can scroll
  // to. Those are the browser reconciling an over-scrolled position, and the
  // reader was sitting still at the tail each time.
  // NOT isTrueBottomGap, which is symmetric: gap -187 is 187 away by absolute
  // value and would slip through. Past the bottom is still at the bottom.
  const movedUp = top < lastTop - UP_JITTER_EPS && heightStable && gap > TRUE_BOTTOM_EPS
  // down-to-bottom: top rose past the jitter eps to within EPS of the true
  // bottom. The shrink case this once guarded — a window shrink collapsing the
  // gap, content rather than the user returning — cannot reach here: a shrink
  // clamps scrollTop DOWN, so top < lastTop and this is already false. Growth
  // can only push the bottom further away, so arriving within EPS during growth
  // still took a real user move. And nothing else scrolls this list down while
  // scrolledUp is true: followOutput is disabled and geometry reconciliation
  // restores the anchor. Requiring !grew therefore excluded nothing and dropped
  // the ordinary case — a message landing while the reader
  // was on their way back down, which left follow off while they sat at the
  // bottom watching the next message not arrive.
  const movedDownToBottom = top > lastTop + UP_JITTER_EPS && gap <= FOLLOW_BOTTOM_EPS

  if (state.hardLocked || state.geometryReconciliation) {
    return { scrolledUp: state.scrolledUp, action: 'none' }
  }

  if (movedUp) {
    // A real upward move is the user — UNAMBIGUOUSLY, even mid-pin: our pins
    // (scrollToIndex LAST) only ever scroll DOWN, and content-height changes are
    // excluded by heightStable. So it is reader intent.
    return { scrolledUp: true, action: state.scrolledUp ? 'none' : 'follow-off' }
  }
  if (movedDownToBottom) {
    // Geometry reconciliation is excluded above. goToTail enters following
    // before it scrolls, so only the reader can reach this branch while reading.
    return { scrolledUp: false, action: state.scrolledUp ? 'follow-on' : 'none' }
  }
  return { scrolledUp: state.scrolledUp, action: 'none' }
}

export function isTrueBottomGap(gap) {
  return Number.isFinite(gap) && Math.abs(gap) <= TRUE_BOTTOM_EPS
}
