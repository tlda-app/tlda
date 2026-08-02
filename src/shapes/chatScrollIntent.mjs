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
export const FOLLOW_CONVERGENCE_GAP = 200
export const TRUE_BOTTOM_EPS = 8

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

  // up-scroll: top fell past the jitter eps AND content didn't shrink (a shrink
  // clamps scrollTop down without the user moving — not a real scroll-up).
  // ...and it has to actually leave the bottom. You cannot scroll up and still
  // be at the bottom: 386 of the 1045 recorded follow-offs left the reader at or
  // PAST it, one as far as gap -187, which is not a position anyone can scroll
  // to. Those are the browser reconciling an over-scrolled position, and the
  // reader was sitting still at the tail each time.
  // NOT isTrueBottomGap, which is symmetric: gap -187 is 187 away by absolute
  // value and would slip through. Past the bottom is still at the bottom.
  const movedUp = top < lastTop - UP_JITTER_EPS && !shrank && gap > TRUE_BOTTOM_EPS
  // down-to-bottom: top rose past the jitter eps to within EPS of the true
  // bottom. The shrink case this once guarded — a window shrink collapsing the
  // gap, content rather than the user returning — cannot reach here: a shrink
  // clamps scrollTop DOWN, so top < lastTop and this is already false. Growth
  // can only push the bottom further away, so arriving within EPS during growth
  // still took a real user move. And nothing else scrolls this list down while
  // scrolledUp is true, which is the only state that consults this: followOutput
  // returns false and settleToTail bails. Requiring !grew therefore excluded
  // nothing and dropped the ordinary case — a message landing while the reader
  // was on their way back down, which left follow off while they sat at the
  // bottom watching the next message not arrive.
  const movedDownToBottom = top > lastTop + UP_JITTER_EPS && gap <= FOLLOW_BOTTOM_EPS

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

export function isTrueBottomGap(gap) {
  return Number.isFinite(gap) && Math.abs(gap) <= TRUE_BOTTOM_EPS
}

export function shouldResumeFollowFromBottom(atBottom, gap) {
  return !!atBottom && isTrueBottomGap(gap)
}
