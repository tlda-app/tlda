/**
 * A3: Switching the fleet-chat filter (chat-target switch) scrolls to bottom.
 *
 * Skip 4/7 4:14pm: "I switch to chat and it doesn't scroll to like I switch
 *                   my chat Target then it should scroll to bottom"
 *
 * Test: Open chat with filter X (lots of history). Scroll up. Switch the
 *       shape's filter to a different agent (Y). After history reload, the
 *       chat-log should be AT BOTTOM, regardless of where it was before.
 */

import { setup, teardown, getScrollState, scrollUp, sendChat, populateChat, pwEval,
         expectAtBottom, Suite, delay } from '../harness.mjs'

const suite = new Suite('A3 chat-target switch')

const agentA = process.env.TLDA_TEST_AGENT || 'tlda-ops'
const agentB = process.env.TLDA_TEST_AGENT_B || 'historian'

const ctx = await setup({ agentName: agentA })

try {
  await populateChat(ctx)

  await suite.run('starts at bottom (filter A)', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // Scroll up so we're decidedly NOT at bottom.
  await scrollUp(ctx, 600)
  await delay(400)
  const beforeSwitch = getScrollState(ctx)
  await suite.run('scrolled up before switch', () =>
    Promise.resolve(beforeSwitch && beforeSwitch.dist > 100
      ? { pass: true, detail: `dist=${beforeSwitch.dist}` }
      : { pass: false, detail: `couldn't scroll up — dist=${beforeSwitch?.dist}` }))

  // Swap the filter on the fleet-chat shape — this is what the chat-target
  // switch UI does internally. New filter = messages to/from agentB.
  pwEval(ctx.sessionName, `(function(){var e=window.__tldraw_editor__;if(!e)return "no editor";var s=e.getCurrentPageShapes().find(function(s){return s.type==="fleet-chat"});if(!s)return "no chat";e.updateShape({id:s.id,type:"fleet-chat",props:{filter:[[["from","${agentB}"]],[["to","${agentB}"]]]}}); return "switched"})()`)
  await delay(3500) // history fetch for new filter

  await suite.run('at bottom after target switch (filter B)', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx), 200)))

  // And now switch back to A — same expectation.
  pwEval(ctx.sessionName, `(function(){var e=window.__tldraw_editor__;var s=e.getCurrentPageShapes().find(function(s){return s.type==="fleet-chat"});e.updateShape({id:s.id,type:"fleet-chat",props:{filter:[[["from","${agentA}"]],[["to","${agentA}"]]]}}); return "switched-back"})()`)
  await delay(3500)

  await suite.run('at bottom after switching back to filter A', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx), 200)))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
