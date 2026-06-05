/**
 * Open the ONE persistent headed window and leave it open.
 *
 * Run once: PERSIST=1 node tests/scroll/open-session.mjs
 * It opens the window, renders the chat HUD, screenshots proof, and does NOT
 * close. Every later run uses REUSE=1 to drive THIS window (no more pops).
 */
import { setup, getScrollState, pw, delay } from '../harness.mjs'

const ctx = await setup({ persist: true, keepOpen: true })
await delay(500)
const s = getScrollState(ctx)
pw(ctx.sessionName, 'screenshot --filename scratch/persist-open.png')
console.log(`session: ${ctx.sessionName}`)
console.log(`userId:  ${ctx.userId}  sender:${ctx.agentId}`)
console.log(`render:  ${s ? `OK msgs=${s.msgs} sH=${s.sH} dist=${s.dist}` : 'NULL — did not render'}`)
console.log(`shot:    scratch/persist-open.png`)
// Do NOT teardown — window stays open for reuse.
process.exit(s ? 0 : 1)
