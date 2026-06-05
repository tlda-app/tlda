/**
 * A5: Inline markdown content arriving doesn't break scroll-to-bottom.
 *
 * Skip 4/7 4:12pm: "or break scroll to bottom like in the presence of
 *                   I don't know like in line markdown or something"
 *
 * Test: at-bottom → send messages with code blocks, headers, bold,
 *       multi-line markdown → still at bottom after each.
 */

import { setup, teardown, getScrollState, scrollToBottom, sendChat,
         expectAtBottom, Suite, delay } from '../harness.mjs'

const suite = new Suite('A5 inline markdown')

const ctx = await setup({ agentName: process.env.TLDA_TEST_AGENT || 'tlda-ops' })

try {
  await scrollToBottom(ctx)
  await delay(500)

  await suite.run('baseline at bottom', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // Code block
  sendChat(ctx, { from: ctx.agentId, to: 'fleet:skip',
    message: '```js\nfunction test() {\n  console.log("hello")\n  return true\n}\n```' })
  await delay(1500)
  await suite.run('at bottom after code block', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // Headers + bold + list
  sendChat(ctx, { from: ctx.agentId, to: 'fleet:skip',
    message: '## Status Update\n\n**Working on:**\n- item one\n- item two\n- item three\n\n> blockquote text here' })
  await delay(1500)
  await suite.run('at bottom after headers/bold/list', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // Inline KaTeX (chat renders math)
  sendChat(ctx, { from: ctx.agentId, to: 'fleet:skip',
    message: 'The bound is $O(n^{-1/2})$ which gives us $$\\int_0^1 f(x) dx \\leq C$$' })
  await delay(1500)
  await suite.run('at bottom after inline math', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // Long code block (tall content)
  const longCode = '```\n' + Array.from({length: 30}, (_, i) => `line ${i}: x = x + ${i}`).join('\n') + '\n```'
  sendChat(ctx, { from: ctx.agentId, to: 'fleet:skip', message: longCode })
  await delay(2000)
  await suite.run('at bottom after 30-line code block', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx), 200)))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
