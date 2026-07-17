/**
 * E2–E5: False userScrolledUp detection scenarios.
 *
 * The scroll handler must NOT mark userScrolledUp when:
 *   E2 — a new message's height change fires a scroll event
 *   E3 — multiline textarea collapses on send (clientHeight grows)
 *   E4 — virtualizer scrollToIndex re-measures items
 *   E5 — programmatic scrollTop = scrollHeight fires a scroll event
 *
 * All tested indirectly: do the thing that COULD falsely trigger it,
 * then send a new message and verify auto-scroll still works.
 */

import { execSync } from 'child_process'
import test from 'node:test'
import { setup, teardown, getScrollState, scrollToBottom, sendChat,
         pwEval, expectAtBottom, Suite, delay } from '../harness.mjs'

const previewPort = parseInt(process.env.TLDA_TEST_PORT || '5179')
const previewPrereq = `requires worktree preview server on :${previewPort} - start with tlda-dev serve`

function hasWorktreePreviewServer() {
  try {
    execSync(`curl -skf -o /dev/null --max-time 2 https://localhost:${previewPort}/`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!hasWorktreePreviewServer()) {
  test('E false-userScrolledUp', { skip: previewPrereq }, () => {})
} else {
const suite = new Suite('E false-userScrolledUp')

const ctx = await setup({})

try {
  await scrollToBottom(ctx)
  await delay(500)

  // E2: new message height change
  sendChat(ctx, { from: ctx.agentId,
    message: '## Big Header\n\n```\ncode block that makes the message tall\nline 2\nline 3\nline 4\nline 5\n```\n\ntext after code' })
  await delay(1500)
  // Now send a FOLLOW-UP — if E2 falsely set userScrolledUp, this won't scroll
  sendChat(ctx, { from: ctx.agentId,
    message: 'E2 follow-up: should auto-scroll' })
  await delay(1200)
  await suite.run('E2: auto-scroll after tall message (no false userup)', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // E3: textarea collapse on send
  // Simulate: grow textarea, then clear it (simulating send), then verify
  pwEval(ctx.sessionName, `(function(){var ta=document.querySelector(".fleet-chat-input-area textarea");if(!ta)return "no ta";ta.value="line1\\nline2\\nline3\\nline4";ta.style.height="auto";ta.style.height=Math.min(ta.scrollHeight,200)+"px";ta.dispatchEvent(new Event("input",{bubbles:true}));return "typed"})()`)
  await delay(500)
  // Clear (simulating send — textarea collapses, clientHeight changes)
  pwEval(ctx.sessionName, `(function(){var ta=document.querySelector(".fleet-chat-input-area textarea");if(!ta)return "no ta";ta.value="";ta.style.height="auto";ta.dispatchEvent(new Event("input",{bubbles:true}));return "cleared"})()`)
  await delay(500)
  // Send follow-up from agent
  sendChat(ctx, { from: ctx.agentId,
    message: 'E3 follow-up: auto-scroll after textarea collapse' })
  await delay(1200)
  await suite.run('E3: auto-scroll after textarea collapse (no false userup)', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // E5: programmatic scroll change
  // Force scrollTop = scrollHeight (programmatic), then send a message
  pwEval(ctx.sessionName, `(function(){var els=document.querySelectorAll(".fleet-chat-log");var best=null,bC=-1;for(var i=0;i<els.length;i++){var c=els[i].querySelectorAll(".chat-line").length;if(c>bC){bC=c;best=els[i]}}if(best)best.scrollTop=best.scrollHeight;return "ok"})()`)
  await delay(300)
  sendChat(ctx, { from: ctx.agentId,
    message: 'E5 follow-up: auto-scroll after programmatic scrollTop set' })
  await delay(1200)
  await suite.run('E5: auto-scroll after programmatic scroll (no false userup)', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

  // E4: virtualizer effect — send a burst of messages rapidly to trigger
  // virtualizer re-measurement, then verify auto-scroll
  for (let i = 0; i < 8; i++) {
    sendChat(ctx, { from: ctx.agentId,
      message: `Burst msg ${i} — triggers virtualizer remeasure` })
  }
  await delay(2000)
  sendChat(ctx, { from: ctx.agentId,
    message: 'E4 follow-up: auto-scroll after virtualizer burst' })
  await delay(1200)
  await suite.run('E4: auto-scroll after rapid burst / virtualizer churn', () =>
    Promise.resolve(expectAtBottom(getScrollState(ctx))))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
}
