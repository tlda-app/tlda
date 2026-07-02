import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideFollowTransition,
  FOLLOW_BOTTOM_EPS,
  FOLLOW_CONVERGENCE_GAP,
  TRUE_BOTTOM_EPS,
  isTrueBottomGap,
  shouldResumeFollowFromBottom,
  shouldConvergeToBottom,
  shouldGlueTailChange,
} from '../src/shapes/chatScrollIntent.mjs'

// Driver: replays a sequence of scroll-event samples through decideFollowTransition
// exactly as the useEffect handler in FleetChatShape does — threading lastTop /
// lastHeight / scrolledUp across events. Each step is { top, height, ch?,
// programmatic?, hardLocked? }. Returns the per-step actions and final intent.
const CH = 100 // clientHeight (viewport) — constant for these scenarios
function replay(start, steps) {
  let lastTop = start.top
  let lastHeight = start.height
  let scrolledUp = start.scrolledUp ?? false
  const actions = []
  for (const s of steps) {
    const ch = s.ch ?? CH
    const { scrolledUp: next, action } = decideFollowTransition(
      { top: s.top, height: s.height, clientHeight: ch, lastTop, lastHeight },
      { scrolledUp, hardLocked: s.hardLocked ?? false, programmatic: s.programmatic ?? false },
    )
    actions.push(action)
    scrolledUp = next
    lastTop = s.top
    lastHeight = s.height
  }
  return { actions, scrolledUp }
}

// CASE A — at bottom, a new message arrives → must KEEP following (must NOT
// register the content growth or the pin's own down-scroll as user intent).
// This is the hard-won auto-follow behavior Skip said must not regress.
test('A: at-bottom new message keeps following (no regress)', () => {
  const { actions, scrolledUp } = replay(
    { top: 1000, height: 1100, scrolledUp: false }, // following at true bottom (gap 0)
    [
      { top: 1000, height: 1300 }, // message appends: height grows, top unmoved → gap opens, NOT a user move
      { top: 1200, height: 1300, programmatic: true }, // pinHard scrolls down to new bottom (fenced)
    ],
  )
  assert.deepEqual(actions, ['none', 'none'])
  assert.equal(scrolledUp, false, 'still following after auto-pin')
})

// CASE B — user scrolls up → follow disengages and STAYS off when the next
// message arrives (the reported "shot back down" bug).
test('B: scroll-up disengages and a new message does NOT re-yank', () => {
  const { actions, scrolledUp } = replay(
    { top: 1000, height: 1100, scrolledUp: false },
    [
      { top: 500, height: 1100 }, // user wheels up 500px (no height change)
      { top: 500, height: 1300 }, // new message grows content; user stays put
    ],
  )
  assert.deepEqual(actions, ['follow-off', 'none'])
  assert.equal(scrolledUp, true, 'still reading history; not re-yanked')
})

// CASE E — THE FIX: a scroll-up that lands INSIDE a pin's programmatic fence must
// still disengage. Fencing it was what discarded the user's intent and let the
// next message re-yank them. (Pins only ever scroll DOWN, so an upward move is
// unambiguously the user even mid-fence.)
test('E: scroll-up inside the programmatic fence still disengages', () => {
  const { actions, scrolledUp } = replay(
    { top: 1000, height: 1100, scrolledUp: false },
    [
      { top: 500, height: 1100, programmatic: true }, // user scrolls up DURING a pin fence
      { top: 500, height: 1300 }, // message arrives → must stay put
    ],
  )
  assert.deepEqual(actions, ['follow-off', 'none'])
  assert.equal(scrolledUp, true)
})

// CASE C — returning to the true bottom resumes follow.
test('C: down-scroll to bottom resumes follow', () => {
  const { actions, scrolledUp } = replay(
    { top: 500, height: 1300, scrolledUp: true }, // reading history
    [{ top: 1200, height: 1300 }], // user scrolls back to bottom (gap 0)
  )
  assert.deepEqual(actions, ['follow-on'])
  assert.equal(scrolledUp, false)
})

// CASE D — a render-window shrink that collapses the gap must NOT be misread as
// a user return-to-bottom (the oscillation: follow OFF→ON→OFF). Two shapes:
test('D1: window shrink (top unmoved) does not resume follow', () => {
  const { actions, scrolledUp } = replay(
    { top: 500, height: 1300, scrolledUp: true },
    [{ top: 500, height: 600 }], // render window shrinks; gap collapses to 0 but top unmoved
  )
  assert.deepEqual(actions, ['none'])
  assert.equal(scrolledUp, true, 'shrink is not a user move')
})

test('D2: shrink that clamps scrollTop down is not misread as a scroll-up', () => {
  const { actions, scrolledUp } = replay(
    { top: 1200, height: 1300, scrolledUp: false }, // following at bottom
    [{ top: 500, height: 600 }], // shrink clamps top 1200→500; shrank guard must suppress follow-off
  )
  assert.deepEqual(actions, ['none'])
  assert.equal(scrolledUp, false, 'a shrink clamp is not a deliberate scroll-up')
})

// CASE F — hardLocked (forced follow) ignores all user-intent transitions.
test('F: hardLocked never disengages', () => {
  const { actions, scrolledUp } = replay(
    { top: 1000, height: 1100, scrolledUp: false },
    [{ top: 200, height: 1100, hardLocked: true }], // big up-scroll while hard-locked
  )
  assert.deepEqual(actions, ['none'])
  assert.equal(scrolledUp, false)
})

// CASE G — sub-jitter noise (< UP_JITTER_EPS) does not flip intent.
test('G: sub-jitter scroll noise is ignored', () => {
  const { actions } = replay(
    { top: 1000, height: 1100, scrolledUp: false },
    [{ top: 998, height: 1100 }], // 2px wobble < UP_JITTER_EPS (4)
  )
  assert.deepEqual(actions, ['none'])
})

// Guard the footer-absorbing threshold: a gap within FOLLOW_BOTTOM_EPS counts as
// "at bottom" for resume; just beyond it does not.
test('H: resume threshold absorbs the status footer but not a real gap', () => {
  const justInside = replay(
    { top: 500, height: 1300, scrolledUp: true },
    [{ top: 500 + (1300 - 500 - CH - (FOLLOW_BOTTOM_EPS - 5)), height: 1300 }],
  )
  assert.equal(justInside.actions[0], 'follow-on', `gap ${FOLLOW_BOTTOM_EPS - 5} ≤ eps resumes`)

  const justOutside = replay(
    { top: 500, height: 1300, scrolledUp: true },
    [{ top: 520, height: 1300 }], // moved down a little but still far from bottom
  )
  assert.equal(justOutside.actions[0], 'none', 'still well above bottom → no resume')
})

test('I: convergence watchdog pins only while following or hard-locked', () => {
  assert.equal(
    shouldConvergeToBottom(FOLLOW_CONVERGENCE_GAP + 1, { scrolledUp: false, hardLocked: false }),
    true,
    'following + persistent gap should re-pin',
  )
  assert.equal(
    shouldConvergeToBottom(FOLLOW_CONVERGENCE_GAP + 1, { scrolledUp: true, hardLocked: false }),
    false,
    'reading history must not be yanked down',
  )
  assert.equal(
    shouldConvergeToBottom(FOLLOW_CONVERGENCE_GAP + 1, { scrolledUp: true, hardLocked: true }),
    true,
    'hard-lock overrides reading state',
  )
})

test('J: tail replacement glues even when list length is constant', () => {
  assert.equal(
    shouldGlueTailChange('db:500', 'db:501', { scrolledUp: false, hardLocked: false }),
    true,
    'new tail while following should glue, including ring-buffer oldest eviction',
  )
  assert.equal(
    shouldGlueTailChange('db:500', 'db:501', { scrolledUp: true, hardLocked: false }),
    false,
    'new tail while reading history must not yank down',
  )
  assert.equal(
    shouldGlueTailChange('db:501', 'db:501', { scrolledUp: false, hardLocked: false }),
    false,
    'same tail is not a new event',
  )
})

test('K: true-bottom is stricter than Virtuoso atBottom threshold', () => {
  assert.equal(isTrueBottomGap(0), true)
  assert.equal(isTrueBottomGap(TRUE_BOTTOM_EPS), true)
  assert.equal(isTrueBottomGap(TRUE_BOTTOM_EPS + 1), false)
  assert.equal(isTrueBottomGap(24), false, 'Virtuoso atBottomThreshold=24 is not enough to prove true bottom')
})

test('L: follow resumes only after Virtuoso atBottom also has true measured bottom', () => {
  assert.equal(
    shouldResumeFollowFromBottom(true, TRUE_BOTTOM_EPS),
    true,
    'atBottom plus true measured gap resumes follow',
  )
  assert.equal(
    shouldResumeFollowFromBottom(true, TRUE_BOTTOM_EPS + 1),
    false,
    'loose atBottom without true measured gap must not resume follow',
  )
  assert.equal(
    shouldResumeFollowFromBottom(false, 0),
    false,
    'true measured gap without Virtuoso bottom state is not a settled bottom',
  )
})
