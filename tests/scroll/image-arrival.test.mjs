/**
 * A2: Inline images arrive → chat scrolls to BOTTOM of image (not top).
 *
 * Skip 4/6 4:31pm: "scroll to bottom isn't working — you send me an image
 * and I see the top of the image but the [bottom is cut off]"
 *
 * Test: at-bottom → server pushes message containing inline image →
 *       wait for image render → assert dist < threshold
 *       (i.e. we are at the bottom of the image, not the top).
 */

import { setup, teardown, getScrollState, scrollToBottom, sendChat,
         expectAtBottom, Suite, delay } from '../harness.mjs'

const suite = new Suite('A2 image arrival')

const ctx = await setup({})

try {
  // Pin to bottom first.
  await scrollToBottom(ctx)
  await delay(500)

  // Image markdown — uses a built-in screenshot from the doc dir
  // so the request resolves quickly.
  const imageMd = '![test image](/docs/test-playback/source/figs/empty.png)\n\nfollowed by some text after the image.'

  await suite.run('starts at bottom before image arrives', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  sendChat(ctx, { from: ctx.agentId, message: imageMd })
  await delay(2500) // allow image fetch + render + scroll-to-bottom to settle

  await suite.run('at bottom after image renders (no top-of-image clip)', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx), 200)))

  // Send a second image — bug pattern is intermittent; cover it twice.
  sendChat(ctx, { from: ctx.agentId, message: '![second image](/docs/test-playback/source/figs/empty.png)' })
  await delay(2500)

  await suite.run('at bottom after second image', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx), 200)))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
