import { decideFollowTransition } from './shapes/chatScrollIntent.mjs'

// Mirrors TOUCH_SCROLL_SETTLE_MS in FleetChatShape.tsx. A momentum glide emits
// scroll events continuously, so this only has to outlast the gap between two
// of them.
const INPUT_SETTLE_MS = 150

// Follow the tail, but only while the reader is actually following it.
//
// decideFollowTransition is the shipped decision — the same one FleetChatShape
// uses — and it only changes state when `userInputActive` is true. That is what
// makes this safe: the programmatic scroll below fires a scroll event of its
// own, and because no gesture is in flight when it does, the decision returns
// 'none' and cannot mistake our own write for the reader moving.
export function attachIndexChatTail(log, rows, ResizeObserverImpl = globalThis.ResizeObserver) {
  let scrolledUp = false
  let lastTop = log.scrollTop
  let lastHeight = log.scrollHeight
  let inputActive = false
  let settleTimer = 0

  const noteInput = () => {
    inputActive = true
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      inputActive = false
      settleTimer = 0
    }, INPUT_SETTLE_MS)
  }

  const onScroll = () => {
    const top = log.scrollTop
    const height = log.scrollHeight
    const next = decideFollowTransition(
      { top, height, clientHeight: log.clientHeight, lastTop, lastHeight },
      // No virtualizer on this surface: nothing re-anchors scrollTop behind the
      // reader's back, so there is no forced-follow mode and no reconciliation
      // seam to preserve.
      { scrolledUp, hardLocked: false, geometryReconciliation: false, userInputActive: inputActive },
    )
    scrolledUp = next.scrolledUp
    lastTop = top
    lastHeight = height
  }

  const followTail = () => {
    if (scrolledUp) return
    log.scrollTop = log.scrollHeight
    lastTop = log.scrollTop
    lastHeight = log.scrollHeight
  }

  followTail()
  log.addEventListener('scroll', onScroll, { passive: true })
  // Pointer parity: wheel, finger and key all prove the same reader intent.
  log.addEventListener('wheel', noteInput, { passive: true })
  log.addEventListener('touchstart', noteInput, { passive: true })
  log.addEventListener('touchmove', noteInput, { passive: true })
  log.addEventListener('keydown', noteInput)
  const observer = new ResizeObserverImpl(followTail)
  observer.observe(rows)
  return () => {
    if (settleTimer) clearTimeout(settleTimer)
    log.removeEventListener('scroll', onScroll)
    log.removeEventListener('wheel', noteInput)
    log.removeEventListener('touchstart', noteInput)
    log.removeEventListener('touchmove', noteInput)
    log.removeEventListener('keydown', noteInput)
    observer.disconnect()
  }
}
