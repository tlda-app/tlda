/**
 * Replay Skip's REAL logged chat events through the chat HUD and check whether
 * the view lands — and stays — at the TRUE bottom.
 *
 * This targets the bug Skip hits on his laptop: a "big blank plank" at the
 * bottom of the chat where he can't see the latest messages. The live client
 * log shows the scroll container's scrollHeight is BISTABLE — it collapses to
 * ~2.6k px then climbs to ~17k px as Virtuoso repeatedly discards and rebuilds
 * its item-size cache. A pin fired during a collapsed measurement parks the
 * view at a false bottom (reports gap:0 while thousands of px sit below).
 *
 * What this test does:
 *   1. Verify the chat HUD actually renders (prints a clear diagnostic if not).
 *   2. Pull ~150 real chat events involving fleet:skip from fleet.db.
 *   3. Replay them rapidly (varied real heights + bursts = the real trigger).
 *   4. Sample scrollHeight repeatedly to detect bistable re-measure thrash.
 *   5. Force scroll-to-bottom and assert the view is actually at the true bottom.
 *
 * Run (from the worktree):
 *   TLDA_TEST_PORT=5179 node tests/scroll/replay-real.mjs
 */

import { setup, teardown, getScrollState, scrollToBottom, sendChat,
         loadEvents, resolveAgentId, pw, Suite, delay } from '../harness.mjs'

const suite = new Suite('replay-real (Skip false-bottom)')
const SHOT = (ctx, name) => pw(ctx.sessionName, `screenshot --filename scratch/replay-${name}.png`)

const ctx = await setup({})

try {
  // --- 1. Did the HUD render? -------------------------------------------
  SHOT(ctx, '1-initial')
  let state = getScrollState(ctx)
  if (!state) {
    console.log('  ✗ chat HUD did NOT render — getScrollState returned null.')
    console.log('    (userId stamping or HUD toggle likely needs adjusting; see scratch/replay-1-initial.png)')
    await suite.run('chat HUD renders', () => Promise.resolve({ pass: false, detail: 'no .fleet-chat-log with chat-line' }))
    throw new Error('HUD render check failed — stopping before replay')
  }
  await suite.run('chat HUD renders', () => Promise.resolve({ pass: true, detail: `msgs=${state.msgs} sH=${state.sH}` }))

  // --- 2. Load real events -----------------------------------------------
  const skipId = resolveAgentId(ctx, 'fleet:skip') || resolveAgentId(ctx, 'skip')
  const events = skipId ? loadEvents(ctx, skipId, 150) : []
  console.log(`  loaded ${events.length} real chat events (skipId=${skipId})`)

  // --- 3. Replay rapidly --------------------------------------------------
  // Use the real message TEXT (varied heights: short acks, long reports, code
  // blocks, markdown) but route through our isolated bots. Bursts with short
  // gaps reproduce the rapid-arrival pattern that thrashes the measure cache.
  await scrollToBottom(ctx)
  await delay(400)
  let n = 0
  for (const ev of events) {
    if (!ev.text) continue
    sendChat(ctx, { message: ev.text })
    n++
    // mostly fast bursts, occasional pause (mirrors real traffic)
    await delay(n % 7 === 0 ? 350 : 90)
  }
  console.log(`  replayed ${n} messages`)
  await delay(2500) // let final reflow + pins settle

  // --- 4. Detect bistable scrollHeight (the re-measure thrash) -----------
  const heights = []
  for (let i = 0; i < 8; i++) {
    const s = getScrollState(ctx)
    if (s) heights.push(s.sH)
    await delay(120)
  }
  const minH = Math.min(...heights), maxH = Math.max(...heights)
  const ratio = minH > 0 ? maxH / minH : 0
  console.log(`  scrollHeight samples: ${heights.join(', ')}  (min=${minH} max=${maxH} ratio=${ratio.toFixed(2)})`)
  SHOT(ctx, '2-after-replay')
  // A stable list stays within a few % across samples. Bistable thrash shows a
  // large ratio (we saw ~2.6k vs ~17k ≈ 6x in Skip's live log).
  await suite.run('scrollHeight is stable (no re-measure thrash)', () =>
    Promise.resolve({ pass: ratio < 1.5, detail: `min=${minH} max=${maxH} ratio=${ratio.toFixed(2)}` }))

  // --- 5. Does scroll-to-bottom reach the TRUE bottom? -------------------
  await scrollToBottom(ctx)
  await delay(600)
  state = getScrollState(ctx)
  SHOT(ctx, '3-after-scrolltobottom')
  await suite.run('scroll-to-bottom reaches true bottom (dist small)', () =>
    Promise.resolve({ pass: !!state && state.dist < 60, detail: state ? `dist=${state.dist} sH=${state.sH} sT=${state.sT}` : 'no state' }))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
