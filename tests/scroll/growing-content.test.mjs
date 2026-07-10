/**
 * A6 + E1: Growing content (activity cards, images loading) doesn't break
 * scroll-to-bottom AND doesn't falsely set userScrolledUp.
 *
 * Skip: "scroll to bottom doesn't work with growing activity cards and
 *        probably other growing shapes"
 *
 * Root cause pattern (E1): image/card renders → scrollHeight grows →
 * scroll handler fires → dist-from-bottom > threshold → userScrolledUp = true
 * → auto-scroll stops permanently. The scroll handler MUST ignore height
 * changes that aren't user-initiated.
 *
 * Test:
 *   1. At bottom → send image → image loads (height grows) → still at bottom
 *   2. After image loads, send a SECOND text message → must still auto-scroll
 *      (proves userScrolledUp was NOT falsely set by the image height change)
 */

import { setup, teardown, getScrollState, scrollToBottom, sendChat,
         expectAtBottom, Suite, delay } from '../harness.mjs'

const suite = new Suite('A6/E1 growing content')

const ctx = await setup({})

try {
  await scrollToBottom(ctx)
  await delay(500)

  await suite.run('baseline at bottom', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // Send image (content will grow when image renders)
  sendChat(ctx, { from: ctx.agentId,
    message: '![screenshot](/docs/test-playback/source/figs/empty.png)\n\ncaption text below image' })
  await delay(3000) // image load + render + scroll settle

  await suite.run('A6: at bottom after image content grows', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx), 200)))

  // E1: NOW send a plain text message. If image height change falsely
  // set userScrolledUp, this message won't auto-scroll.
  sendChat(ctx, { from: ctx.agentId,
    message: 'follow-up text after image — this MUST auto-scroll' })
  await delay(1500)

  await suite.run('E1: auto-scroll works after image height change (no false userup)', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // Rapid content growth: 5 messages with varying height in quick succession
  for (let i = 0; i < 5; i++) {
    const tall = i % 2 === 0
    sendChat(ctx, { from: ctx.agentId,
      message: tall
        ? `Tall message ${i}\n\n- bullet one\n- bullet two\n- bullet three\n\n\`\`\`\ncode line\n\`\`\``
        : `Short message ${i}` })
    await delay(300)
  }
  await delay(2000)

  await suite.run('at bottom after rapid mixed-height burst', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx), 200)))

  // One more text message to confirm auto-scroll still engaged
  sendChat(ctx, { from: ctx.agentId,
    message: 'final verification message' })
  await delay(1500)

  await suite.run('auto-scroll still engaged after mixed burst', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
