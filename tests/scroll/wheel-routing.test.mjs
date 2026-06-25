/**
 * B3, B4, G1: Wheel events on chat-log — real mouse.wheel through the full
 * browser input pipeline (capture phase, CanvasClipPanel routing, etc).
 *
 * Skip 4/7 6:28pm: "it's hard to go to the top on like manual scroll like
 *                   there's like a bouncing it kind of like fight"
 *
 * Uses playwright npm (page.mouse.wheel) for real CDP-level wheel events.
 * Setup mirrors tests/scroll-playback.mjs (the proven pattern) exactly.
 */

import { chromium } from 'playwright'
import { setTimeout as delay } from 'timers/promises'
import { homedir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'

const PORT = process.env.TLDA_TEST_PORT || '5179'
const TOKEN = process.env.TLDA_TEST_TOKEN || '15fc7709df6bf2f804c7e3d75ab8b34a'
const DOC = process.env.TLDA_TEST_DOC || 'test-playback'
const AGENT_NAME = process.env.TLDA_TEST_AGENT || 'tlda-ops'

const db = new Database(join(homedir(), '.config', 'tlda', 'fleet.db'), { readonly: true })
const agent = db.prepare('SELECT id FROM agents WHERE friendly_name=?').get(AGENT_NAME)
if (!agent) { console.error(`Agent "${AGENT_NAME}" not found`); process.exit(1) }
const agentId = agent.id
db.close()

async function sendChat(message) {
  try {
    await fetch(`http://localhost:${PORT}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: agentId, to: 'fleet:skip', message }),
    })
  } catch {}
}

async function getScrollState(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('.fleet-chat-log')
    let best = null, bestC = -1
    for (const el of els) {
      const c = el.querySelectorAll('.chat-line').length
      if (c > bestC) { bestC = c; best = el }
    }
    if (!best) return null
    return {
      dist: Math.round(best.scrollHeight - best.scrollTop - best.clientHeight),
      sH: Math.round(best.scrollHeight),
      sT: Math.round(best.scrollTop),
      cH: Math.round(best.clientHeight),
      msgs: bestC,
    }
  })
}

async function getChatLogCenter(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('.fleet-chat-log')
    let best = null, bestC = -1
    for (const el of els) {
      const c = el.querySelectorAll('.chat-line').length
      if (c > bestC) { bestC = c; best = el }
    }
    if (!best) return null
    const r = best.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
}

let passed = 0, failed = 0
function assert(name, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${name}`); passed++ }
  else { console.log(`  ✗ ${name} ${detail}`); failed++ }
}

console.log('\n=== B/G Wheel-Scroll Routing (real mouse.wheel) ===\n')

const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({
  recordVideo: { dir: '/tmp/wheel-test-video/' },
  viewport: { width: 1400, height: 900 },
})
const page = await context.newPage()

try {
  await page.goto(`http://localhost:${PORT}/?doc=${DOC}&name=skip&token=${TOKEN}&pw=1`)
  await delay(12000) // match scroll-playback.mjs timing

  // Clean up accumulated shapes from previous test runs, then create one fresh one
  await page.evaluate((name) => {
    const e = window.__tldraw_editor__
    if (!e) return
    const old = e.getCurrentPageShapes().filter(s => s.type === 'fleet-chat')
    if (old.length > 0) e.deleteShapes(old.map(s => s.id))
    e.createShape({
      type: 'fleet-chat', x: -1200, y: 0,
      props: { w: 400, h: 600, filter: [[[`to`, name], [`from`, name]]] },
    })
    localStorage.setItem('fleet-hud-expanded', '1')
  }, AGENT_NAME)
  await delay(2000)
  // Toggle HUD only if chat-log not already visible
  const needsToggle = await page.evaluate(() => !document.querySelector('.fleet-chat-log'))
  if (needsToggle) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fleet-hud-toggle')))
  }
  await delay(5000)

  // Inject filler messages through vite proxy (same port as browser)
  for (let i = 0; i < 25; i++) {
    await sendChat(`Filler ${i}: padding for wheel scroll test.\nLine 2.\nLine 3.`)
    if (i % 5 === 4) await delay(200)
  }
  await delay(2000)

  // Force scroll to bottom
  await page.evaluate(() => {
    const els = document.querySelectorAll('.fleet-chat-log')
    let best = null, bestC = -1
    for (const el of els) {
      const c = el.querySelectorAll('.chat-line').length
      if (c > bestC) { bestC = c; best = el }
    }
    if (best) best.scrollTop = best.scrollHeight
  })
  await delay(500)

  const before = await getScrollState(page)
  console.log(`  [debug] before: ${JSON.stringify(before)}`)

  const scrollable = before && before.sH > before.cH + 100
  assert('setup: chat has scrollable content',
    scrollable,
    `sH=${before?.sH} cH=${before?.cH} msgs=${before?.msgs}`)

  if (!scrollable) {
    console.log('\n  Chat not scrollable — cannot test wheel. Skipping.')
    console.log(`\n${passed}/${passed + failed} passed`)
    await context.close()
    await browser.close()
    process.exit(1)
  }

  assert('setup: at bottom before wheel', before.dist < 50,
    `dist=${before.dist}`)

  // Move mouse over the chat-log center
  const center = await getChatLogCenter(page)
  await page.mouse.move(center.x, center.y)
  await delay(200)

  // B3/G1: real wheel-up (negative deltaY = scroll up)
  await page.mouse.wheel(0, -300)
  await delay(800)

  const afterWheel = await getScrollState(page)
  console.log(`  [debug] afterWheel: ${JSON.stringify(afterWheel)}`)

  assert('B3/G1: wheel-up actually scrolls chat',
    afterWheel && afterWheel.sT < before.sT - 20,
    `sT before=${before.sT} after=${afterWheel?.sT}`)

  assert('B3: scrolled up after wheel',
    afterWheel && afterWheel.dist > 50,
    `dist=${afterWheel?.dist}`)

  // B4: no bounce-back after 2 seconds
  await delay(2000)
  const noBounce = await getScrollState(page)
  assert('B4: no bounce-back 2s after wheel-up',
    noBounce && afterWheel && Math.abs(noBounce.dist - afterWheel.dist) < 50,
    `dist after=${afterWheel?.dist} now=${noBounce?.dist}`)

  // G1: 5 rapid wheel-ups compound
  const startSt = await getScrollState(page)
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -150)
    await delay(100)
  }
  await delay(500)
  const afterFive = await getScrollState(page)
  assert('G1: 5 rapid wheel-ups all compound',
    afterFive && startSt && afterFive.sT < startSt.sT - 30,
    `sT ${startSt?.sT} → ${afterFive?.sT}`)

  console.log(`\n${passed}/${passed + failed} passed`)

} finally {
  await context.close()
  await browser.close()
  console.log('Video saved to /tmp/wheel-test-video/')
}

process.exit(failed > 0 ? 1 : 0)
