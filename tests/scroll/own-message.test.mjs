/**
 * F1, F2: Sending your own message — the "don't yank" behavior.
 *
 * Skip 4/8 (memory): "I don't want it to scroll me to the bottom to see my
 *                     message why would I need to see a message that I fucking wrote"
 *
 *   F1 — sending while SCROLLED UP must NOT yank to bottom
 *   F2 — sending while AT BOTTOM stays at bottom (the message-display still works)
 *
 * NB: F1 is the controversial one. Confirmed with Skip — testing the "don't yank"
 * interpretation. If we later decide send should always scroll, this test flips.
 */

import { setup, teardown, getScrollState, scrollToBottom, scrollUp, sendChat, populateChat,
         expectAtBottom, expectScrolledUp, expectStable, Suite, delay } from '../harness.mjs'

const suite = new Suite('F send-own-message')

const ctx = await setup({ agentName: process.env.TLDA_TEST_AGENT || 'tlda-ops' })

try {
  await populateChat(ctx)

  // F2 first — easier baseline.
  await scrollToBottom(ctx)
  await delay(400)
  sendChat(ctx, { from: 'fleet:skip', to: ctx.agentId, message: 'sent from-skip while at bottom' })
  await delay(1200)
  await suite.run('F2: send while at bottom → still at bottom', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // F1 — scroll up, send, expect to STAY scrolled up.
  await scrollUp(ctx, 600)
  await delay(500)
  const before = getScrollState(ctx)
  if (!before || before.dist < 100) {
    await suite.run('F1 setup: scrolled up before send', () =>
      Promise.resolve({ pass: false, detail: `couldn't scroll up — dist=${before?.dist}` }))
  } else {
    await suite.run('F1 setup: scrolled up before send', () =>
      Promise.resolve(expectScrolledUp(before)))

    sendChat(ctx, { from: 'fleet:skip', to: ctx.agentId, message: 'sent from-skip while scrolled up' })
    await delay(1500)
    const after = getScrollState(ctx)
    await suite.run('F1: send doesn\'t yank to bottom (stays scrolled up)', () =>
      Promise.resolve(after && before
        ? expectStable(before.dist, after.dist, 80)
        : { pass: false, detail: 'no scroll state' }))
  }

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
