/**
 * Reproduce Skip's false-bottom / "blank plank" bug.
 *
 * Symptom: while sitting AT the bottom, new messages arrive and the view does
 * NOT stay at the true bottom — it parks above a gap of blank space while the
 * code believes it's at the bottom. Skip's live log showed the scrollHeight
 * going bistable (collapse→climb) as Virtuoso discards/rebuilds its item-size
 * cache under rapid arrival of tall, late-reflowing content.
 *
 * This test recreates the real trigger that a plain-text replay missed:
 *   - tall, late-reflowing items (network images that load/err after mount,
 *     big code blocks, KaTeX) interleaved with tiny acks → high height variance
 *   - rapid bursts (near-zero gap) → defeats measure-cache stabilization
 *   - repeated cycles → catches the INTERMITTENT tip
 *
 * It does NOT manually scroll to the bottom before measuring — the whole point
 * is whether AUTO-FOLLOW keeps you pinned. We track the WORST case across all
 * cycles. On buggy code this goes RED (worstDist large); a correct consolidation
 * keeps worstDist small every cycle.
 *
 * Run: TLDA_TEST_PORT=5179 node tests/scroll/reproduce-thrash.mjs
 */

import { setup, teardown, getScrollState, scrollToBottom, sendChat,
         pw, Suite, delay } from '../harness.mjs'

const suite = new Suite('reproduce-thrash (false-bottom)')

// A network image at a path that resolves slowly or 404s → its row height
// changes AFTER mount (the real late-reflow trigger).
const LATE_IMG = (n) => `https://localhost:5176/docs/test-playback/__nope__/late-${n}.png`

function tall(n) {
  return [
    `### Report ${n}`,
    'Prose with **bold**, `inline code`, and a late-loading image below.',
    '',
    `![late](${LATE_IMG(n)})`,
    '',
    '```js',
    ...Array.from({ length: 8 }, (_, i) => `const v${i} = ${n * 10 + i}; // line ${i}`),
    '```',
    '',
    `Display math: $$\\sum_{i=1}^{${n}} \\frac{x_i^2}{${n}} = \\alpha_{${n}}$$`,
  ].join('\n')
}
const short = (n) => `ack ${n}`

const ctx = await setup({})

try {
  let state = getScrollState(ctx)
  await suite.run('chat HUD renders', () =>
    Promise.resolve({ pass: !!state, detail: state ? `sH=${state.sH}` : 'no state' }))
  if (!state) throw new Error('render failed — stopping')

  // Start AT the bottom; auto-follow should keep us there as content arrives.
  await scrollToBottom(ctx)
  await delay(500)

  let worstDist = 0
  let worstRatio = 1
  const CYCLES = 6, BURST = 30
  for (let c = 0; c < CYCLES; c++) {
    // Rapid burst of mixed-height content, near-zero gap.
    for (let i = 0; i < BURST; i++) {
      const n = c * BURST + i
      sendChat(ctx, { message: i % 3 === 0 ? tall(n) : short(n) })
      await delay(40)
    }
    // Let late images error/reflow and pins fire. Do NOT manually scroll.
    await delay(1800)

    // Sample height a few times to catch bistable re-measure.
    const heights = []
    let cycDist = 0
    for (let s = 0; s < 5; s++) {
      const st = getScrollState(ctx)
      if (st) { heights.push(st.sH); cycDist = Math.max(cycDist, st.dist) }
      await delay(140)
    }
    const minH = Math.min(...heights), maxH = Math.max(...heights)
    const ratio = minH > 0 ? maxH / minH : 1
    worstDist = Math.max(worstDist, cycDist)
    worstRatio = Math.max(worstRatio, ratio)
    console.log(`  cycle ${c}: dist(max)=${cycDist} heights=[${minH}..${maxH}] ratio=${ratio.toFixed(2)}`)
    pw(ctx.sessionName, `screenshot --filename scratch/thrash-cycle-${c}.png`)
  }

  console.log(`\n  WORST across ${CYCLES} cycles: dist=${worstDist}  heightRatio=${worstRatio.toFixed(2)}`)

  // The bug, expressed as invariants. On buggy code these go RED.
  await suite.run('auto-follow holds bottom every cycle (worstDist small)', () =>
    Promise.resolve({ pass: worstDist < 120, detail: `worstDist=${worstDist}` }))
  await suite.run('no bistable re-measure thrash (worstRatio < 1.5)', () =>
    Promise.resolve({ pass: worstRatio < 1.5, detail: `worstRatio=${worstRatio.toFixed(2)}` }))

} finally {
  await teardown(ctx)
}

const r = suite.summary()
process.exit(r.failed > 0 ? 1 : 0)
