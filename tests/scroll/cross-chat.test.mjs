/**
 * A8: Cross-chat consistency — scroll-to-bottom works in ALL chat shapes,
 * not just one.
 *
 * Skip 4/7 4:12pm: "scroll the bottom just broke everywhere like historian
 *                   same thing like it's just it's just broken now"
 *
 * Test: create TWO fleet-chat shapes with different filters. Send messages
 * to both. Both must auto-scroll to bottom independently.
 */

import { setup, teardown, getScrollState, scrollToBottom, sendChat,
         pwEval, expectAtBottom, Suite, delay, cfg } from '../harness.mjs'

const suite = new Suite('A8 cross-chat consistency')

const agentA = process.env.TLDA_TEST_AGENT || 'tlda-ops'
const agentB = process.env.TLDA_TEST_AGENT_B || 'help-m7'

const ctx = await setup({ filter: [[['from', agentA]], [['to', agentA]]] })

try {
  // Create a SECOND fleet-chat shape filtered to agentB
  pwEval(ctx.sessionName, `(function(){var e=window.__tldraw_editor__;if(!e)return "no editor";e.createShape({type:"fleet-chat",x:-600,y:0,props:{w:400,h:600,filter:[[["from","${agentB}"]],[["to","${agentB}"]]]}});return "shape2 created"})()`)
  await delay(3000)

  // Helper: get scroll state for a SPECIFIC chat-log by index
  function getScrollStateAt(idx) {
    const r = pwEval(ctx.sessionName, `(function(){var els=document.querySelectorAll(".fleet-chat-log");if(els.length<=${idx})return "NO_EL";var el=els[${idx}];return JSON.stringify({dist:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight),sH:Math.round(el.scrollHeight),sT:Math.round(el.scrollTop),cH:Math.round(el.clientHeight)})})()`)
    const u = r.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const m = u.match(/\{"dist":-?\d+.*?\}/)
    if (!m) return null
    try { return JSON.parse(m[0]) } catch { return null }
  }

  // Count chat-logs to verify both shapes are rendered
  const countR = pwEval(ctx.sessionName, `(function(){return ""+document.querySelectorAll(".fleet-chat-log").length})()`)
  const count = parseInt((countR.match(/\d+/) || ['0'])[0])
  await suite.run('two chat-logs in DOM', () =>
    Promise.resolve(count >= 2
      ? { pass: true, detail: `${count} chat-logs found` }
      : { pass: false, detail: `only ${count} chat-logs — need 2` }))

  if (count >= 2) {
    // Send messages to chat A
    for (let i = 0; i < 5; i++) {
      sendChat(ctx, { from: ctx.agentId,
        message: `Chat-A message ${i} — ${Date.now()}` })
      await delay(200)
    }
    await delay(1500)

    const stateA = getScrollStateAt(0)
    await suite.run('chat A at bottom after messages', () =>
      Promise.resolve(expectAtBottom(stateA)))

    // Send messages to chat B (from agentB's perspective).
    const dbB = (await import('better-sqlite3')).default
    const db = new dbB(cfg.dbPath, { readonly: true })
    const bAgent = db.prepare('SELECT id FROM agents WHERE friendly_name=?').get(agentB)
    db.close()
    if (bAgent) {
      for (let i = 0; i < 5; i++) {
        sendChat(ctx, { from: bAgent.id,
          message: `Chat-B message ${i} — ${Date.now()}` })
        await delay(200)
      }
      await delay(1500)

      const stateB = getScrollStateAt(1)
      await suite.run('chat B at bottom after messages', () =>
        Promise.resolve(expectAtBottom(stateB)))
    } else {
      await suite.run('chat B at bottom after messages', () =>
        Promise.resolve({ pass: false, detail: `agent "${agentB}" not in DB` }))
    }

    // Now send to BOTH simultaneously
    sendChat(ctx, { from: ctx.agentId, message: 'simultaneous A' })
    if (bAgent) sendChat(ctx, { from: bAgent.id, message: 'simultaneous B' })
    await delay(1500)

    await suite.run('both chats at bottom after simultaneous send', () => {
      const a = getScrollStateAt(0)
      const b = getScrollStateAt(1)
      const aOk = a && a.dist < 150
      const bOk = b && b.dist < 150
      return Promise.resolve({
        pass: aOk && bOk,
        detail: `A dist=${a?.dist} B dist=${b?.dist}`
      })
    })
  }

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
