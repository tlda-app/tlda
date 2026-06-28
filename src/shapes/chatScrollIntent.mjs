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
export const UP_JITTER_EPS = 4 // ignore sub-pixel / rounding scroll noise
export const FOLLOW_CONVERGENCE_GAP = 200

/**
 * @param {{top:number, height:number, clientHeight:number, lastTop:number, lastHeight:number}} sample
 *   top/height = current scrollTop/scrollHeight; lastTop/lastHeight = previous event's values.
 * @param {{scrolledUp:boolean, hardLocked:boolean, programmatic:boolean}} state
 *   scrolledUp = current userScrolledUpRef; hardLocked = forced-follow; programmatic = inside a pin fence.
 * @returns {{scrolledUp:boolean, action:'follow-off'|'follow-on'|'none'}}
 */
export function decideFollowTransition(sample, state) {
  const { top, height, clientHeight, lastTop, lastHeight } = sample
  const gap = height - top - clientHeight
  const shrank = height < lastHeight - 2
  const grew = height > lastHeight + 2

  // up-scroll: top fell past the jitter eps AND content didn't shrink (a shrink
  // clamps scrollTop down without the user moving — not a real scroll-up).
  const movedUp = top < lastTop - UP_JITTER_EPS && !shrank
  // down-to-bottom: top rose past the jitter eps to within EPS of the true
  // bottom AND content didn't grow. (Gap<=EPS alone wrongly re-engaged follow
  // when a window shrink collapsed the gap — content, not the user, returning.)
  const movedDownToBottom = top > lastTop + UP_JITTER_EPS && !grew && gap <= FOLLOW_BOTTOM_EPS

  if (state.hardLocked) return { scrolledUp: state.scrolledUp, action: 'none' }

  if (movedUp) {
    // A real upward move is the user — UNAMBIGUOUSLY, even mid-pin: our pins
    // (scrollToIndex LAST) only ever scroll DOWN, and a content-shrink clamp is
    // excluded by !shrank. So honor it regardless of the programmatic fence —
    // fencing it was what discarded a scroll-up that landed in a pin's window
    // and let the next message re-yank the reader down.
    return { scrolledUp: true, action: state.scrolledUp ? 'none' : 'follow-off' }
  }
  if (movedDownToBottom && !state.programmatic) {
    // Resume only on a genuine user down-move to the true bottom. Fence out the
    // pin's own downward motion (harmless — we only pin while already following
    // — but keep the signal clean).
    return { scrolledUp: false, action: state.scrolledUp ? 'follow-on' : 'none' }
  }
  return { scrolledUp: state.scrolledUp, action: 'none' }
}

export function shouldConvergeToBottom(gap, state) {
  return gap > FOLLOW_CONVERGENCE_GAP && (!state.scrolledUp || state.hardLocked)
}

export function shouldGlueTailChange(prevTail, nextTail, state) {
  return !!nextTail && nextTail !== prevTail && (!state.scrolledUp || state.hardLocked)
}
