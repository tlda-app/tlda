/**
 * C1–C4: Scroll-to-bottom button (the ↓ arrow).
 *
 * Skip 4/7 4:22pm: "the scroll button doesn't work"
 * Skip 4/7 4:34pm: "look just make a to-do about the fucking scroll Arrow"
 * Skip 4/7 4:16pm: "should also just be a button like scroll to bottom
 *                   like on the top right of the chat or something"
 *
 * The button:
 *   C1 — visible when user is scrolled up
 *   C2 — hidden when at bottom
 *   C3 — clicking it returns to bottom AND re-engages auto-scroll
 *   C4 — wheel-scrolling back to bottom (Magic Mouse) hides it again
 */

import { setup, teardown, getScrollState, getScrollButtonState,
         scrollToBottom, scrollUp, pw, pwEval, sendChat, populateChat,
         expectAtBottom, expectScrolledUp, expectButtonVisible, expectButtonHidden,
         Suite, delay } from '../harness.mjs'

const suite = new Suite('C scroll-to-bottom button')

const ctx = await setup({})

try {
  await populateChat(ctx)
  await scrollToBottom(ctx)
  await delay(400)

  // C2 — hidden at bottom
  await suite.run('C2: button hidden when at bottom', () =>
    Promise.resolve(expectButtonHidden(getScrollButtonState(ctx))))

  // C1 — visible when scrolled up
  await scrollUp(ctx, 600)
  await delay(500)
  const sUp = getScrollState(ctx)
  if (!sUp || sUp.dist < 100) {
    await suite.run('C1: button visible when scrolled up', () =>
      Promise.resolve({ pass: false, detail: `couldn't scroll up — dist=${sUp?.dist}` }))
  } else {
    await suite.run('C1: button visible when scrolled up', () =>
      Promise.resolve(expectButtonVisible(getScrollButtonState(ctx))))
  }

  // C3 — click the button. Use DOM click() because the button is inside a
  // height:0 absolute-positioned div that playwright-cli can't hit-test.
  pwEval(ctx.sessionName, `(function(){var btn=document.querySelector(".fleet-scroll-bottom-btn");if(btn){btn.click();return "clicked"}return "no btn"})()`)
  await delay(800)
  await suite.run('C3a: at bottom after button click', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))
  // Re-engages auto-scroll: send a message, expect to follow.
  sendChat(ctx, { from: ctx.agentId, message: 'post-click message — should follow' })
  await delay(1200)
  await suite.run('C3b: auto-scroll re-engaged after click (new msg follows)', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // C4 — wheel back to bottom hides button (regression: Magic Mouse scroll to bottom
  // should update button visibility — Skip 4/8 "the chat scroll happens but the button doesn't")
  await scrollUp(ctx, 600)
  await delay(500)
  await suite.run('C4 setup: button visible after scrolling up again', () =>
    Promise.resolve(expectButtonVisible(getScrollButtonState(ctx))))
  // Use wheelScrollUp's pattern in reverse — dispatch a positive-deltaY wheel until bottom
  await scrollToBottom(ctx) // simulate Magic Mouse arriving back at bottom
  await delay(800)
  await suite.run('C4: button hidden after wheel-back-to-bottom', () =>
    Promise.resolve(expectButtonHidden(getScrollButtonState(ctx))))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
