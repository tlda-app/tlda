/**
 * Replay an ENTIRE day of Skip's real chat traffic through the chat HUD, sped
 * up, and catch the false-bottom the moment it happens.
 *
 * Why this and not replay-real.mjs:
 *   Skip sees ~1,900 messages a day. The old test replayed 150 (~8% of a day)
 *   and sampled scroll state only AFTER everything settled. That can never see
 *   his bug, which (a) only emerges once the Virtuoso item-size cache has grown
 *   across thousands of varied-height rows, and (b) is a TRANSIENT gap that
 *   appears while messages are arriving and then persists. Sampling after the
 *   dust settles misses it by construction.
 *
 * What this does differently:
 *   - Pulls a full real day (loadDay) — every message Skip would see, in order.
 *   - Preserves burst structure: replay gap = clamp(realGap / SPEED, MIN, MAX),
 *     so rapid real bursts stay rapid (the cache-thrash trigger) while idle time
 *     is compressed.
 *   - Samples dist CONTINUOUSLY. On any large dist it PAUSES sends and rechecks
 *     after 700ms: a gap that survives with no new messages arriving is the
 *     real false-bottom (auto-follow failed to catch up) — not a transient
 *     mid-burst blip. That is exactly Skip's symptom: a blank plank that stays.
 *   - Tracks scrollHeight to flag the bistable collapse→climb re-measure thrash
 *     seen in his live client.log (~2.6k ↔ ~17k).
 *
 * Run from the worktree:
 *   TLDA_TEST_PORT=5179 node tests/scroll/replay-day.mjs
 *   REPLAY_DATE=2026-06-03 SPEED=80 LIMIT=0 node tests/scroll/replay-day.mjs
 */

import { setup, teardown, getScrollState, scrollToBottom, sendChat,
         loadDay, listChatDays, pw, Suite, delay } from '../harness.mjs'

const SPEED      = parseFloat(process.env.SPEED || '80')   // wall-clock compression
const MIN_DELAY  = parseInt(process.env.MIN_DELAY || '12') // floor (keeps bursts tight)
const MAX_DELAY  = parseInt(process.env.MAX_DELAY || '200')// cap (compresses idle gaps)
const THRESH     = parseInt(process.env.THRESH || '150')   // px below true bottom = "gap"
const RECHECK_MS = parseInt(process.env.RECHECK_MS || '700')
const SAMPLE_EVERY = parseInt(process.env.SAMPLE_EVERY || '4')
const LIMIT      = parseInt(process.env.LIMIT || '0')      // 0 = whole day
const SHOT = (ctx, name) => pw(ctx.sessionName, `screenshot --filename scratch/day-${name}.png`)

const suite = new Suite('replay-day (full-day false-bottom)')
const ctx = await setup({})

try {
  // --- pick the day ------------------------------------------------------
  const days = listChatDays(ctx, 'fleet:skip', 14)
  console.log('  available days (skip-involved):')
  for (const d of days) console.log(`    ${d.d}  ${d.c}`)
  // Default: most recent day with a real workload (>1000 msgs), else newest.
  const date = process.env.REPLAY_DATE ||
    (days.find(d => d.c > 1000)?.d) || days[0]?.d
  let events = loadDay(ctx, { date, who: 'fleet:skip' })
  if (LIMIT > 0) events = events.slice(0, LIMIT)
  console.log(`\n  replaying ${events.length} real messages from ${date} ` +
    `(SPEED=${SPEED} floor=${MIN_DELAY}ms cap=${MAX_DELAY}ms)`)

  let state = getScrollState(ctx)
  await suite.run('chat HUD renders', () =>
    Promise.resolve({ pass: !!state, detail: state ? `sH=${state.sH}` : 'no state' }))
  if (!state) throw new Error('render failed — stopping')

  await scrollToBottom(ctx)
  await delay(400)

  // --- replay + continuous detection ------------------------------------
  let worstPersistentDist = 0
  let incidents = 0
  let minSH = Infinity, maxSH = 0, maxDropRatio = 1, prevSH = null
  let firstShot = false
  const t0 = Date.now()

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    sendChat(ctx, { message: ev.text })

    const d = Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(ev.gapMs / SPEED)))
    await delay(d)

    if (i % SAMPLE_EVERY !== 0) continue
    const s = getScrollState(ctx)
    if (!s) continue
    // track scrollHeight bistability (collapse then climb)
    if (s.sH < minSH) minSH = s.sH
    if (s.sH > maxSH) maxSH = s.sH
    if (prevSH != null && s.sH > 0 && prevSH > s.sH) {
      maxDropRatio = Math.max(maxDropRatio, prevSH / s.sH)
    }
    prevSH = s.sH

    // Large gap while we never scrolled up → maybe false-bottom. Confirm it
    // PERSISTS with no new sends (that's the bug; a mid-burst blip self-heals).
    if (s.dist > THRESH) {
      await delay(RECHECK_MS)
      const s2 = getScrollState(ctx)
      if (s2 && s2.dist > THRESH) {
        incidents++
        worstPersistentDist = Math.max(worstPersistentDist, s2.dist)
        const at = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(`  ⚠ FALSE-BOTTOM @msg ${i}/${events.length} t+${at}s: ` +
          `dist=${s2.dist} sH=${s2.sH} sT=${s2.sT} cH=${s2.cH} (persisted ${RECHECK_MS}ms)`)
        if (!firstShot) { SHOT(ctx, `incident-${i}`); firstShot = true }
      }
    }
  }

  await delay(1500)
  const tail = getScrollState(ctx)
  SHOT(ctx, 'final')
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n  replayed ${events.length} msgs in ${elapsed}s`)
  console.log(`  scrollHeight range: ${minSH}..${maxSH}  maxDropRatio=${maxDropRatio.toFixed(2)}`)
  console.log(`  false-bottom incidents: ${incidents}  worstPersistentDist=${worstPersistentDist}`)
  console.log(`  tail state: ${tail ? `dist=${tail.dist} sH=${tail.sH}` : 'none'}`)

  // --- invariants (RED on buggy code) -----------------------------------
  await suite.run('no persistent false-bottom during the day', () =>
    Promise.resolve({ pass: incidents === 0,
      detail: `incidents=${incidents} worstPersistentDist=${worstPersistentDist}` }))
  await suite.run('no bistable scrollHeight collapse (dropRatio < 1.5)', () =>
    Promise.resolve({ pass: maxDropRatio < 1.5, detail: `maxDropRatio=${maxDropRatio.toFixed(2)} range=${minSH}..${maxSH}` }))
  await suite.run('ends at true bottom', () =>
    Promise.resolve({ pass: !!tail && tail.dist < THRESH, detail: tail ? `dist=${tail.dist}` : 'no state' }))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
