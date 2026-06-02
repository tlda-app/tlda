#!/usr/bin/env node
/**
 * Scroll Playback Test
 *
 * Replays real chat events through a fleet-chat shape in a headed browser,
 * verifying scroll invariants at each step.
 *
 * Usage:
 *   node test/scroll-playback.mjs [--doc test-scroll] [--port 5184] [--mode current|candidate]
 *
 * Prerequisites:
 *   - Vite dev server running on --port (default 5184)
 *   - tlda server running on 5176
 *   - Test doc created: tlda create test-scroll --dir /tmp/test-doc --format svg
 *
 * What it tests:
 *   1. Initial load scrolls to bottom
 *   2. New messages keep scroll at bottom (when already at bottom)
 *   3. User can scroll up (scroll position is preserved)
 *   4. New messages while scrolled up do NOT force scroll to bottom
 *   5. Scrolling back to bottom re-enables auto-scroll
 *   6. In-place growth (late-loading image/math) while at bottom keeps you pinned
 *   7. Complex (reflowing) new message while scrolled up does NOT yank to bottom
 */

import { chromium } from 'playwright'
import WebSocket from 'ws'

const DOC = process.argv.includes('--doc') ? process.argv[process.argv.indexOf('--doc') + 1] : 'test-scroll'
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '5184'
const MODE = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'current'
const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c'
const FLEET_API = 'https://localhost:5176'
// Chat is delivered over the fleet WebSocket (the old POST /api/chat REST route
// no longer exists). Mirror eliza.mjs: connect, register a sender, send
// {type:'chat', from, to, message}.
const WS_URL = FLEET_API.replace(/^http/, 'ws') + '/ws/fleet'

if (MODE !== 'current' && MODE !== 'candidate') {
  console.error(`Invalid --mode "${MODE}" (expected "current" or "candidate")`)
  process.exit(2)
}

// --- Complex, late-reflowing content fixtures ---
// These add pixels AFTER the message row first mounts (markdown reflow, KaTeX
// layout, late image load), which is the real auto-scroll failure trigger.
// A 1x1 PNG scaled up via markdown can't grow tall, so we use a tall SVG data URL.
const TALL_SVG = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#446"/><text x="20" y="100" fill="#fff" font-size="20">late-loading image</text></svg>'
).toString('base64')

function complexMessage(n) {
  return [
    `### Complex message ${n}`,
    '',
    'Some prose with **bold** and `inline code` to force markdown reflow.',
    '',
    '- bullet one',
    '- bullet two',
    '- bullet three',
    '',
    '```js',
    `const x = ${n}; // code block adds height`,
    'function f(a){ return a * 2 }',
    '```',
    '',
    'Inline math $\\sum_{i=1}^{n} x_i^2$ and display:',
    '',
    '$$\\int_0^1 \\frac{e^{x}}{1+x^2}\\,dx = \\alpha_' + n + '$$',
    '',
    `![](${TALL_SVG})`,
  ].join('\n')
}

// --- Fleet WS client (sends chat over wss://…/ws/fleet) ---
// Unique per run so the observed chat starts EMPTY (no global tlda-ops backlog
// polluting scroll measurements). Filter the chat shape to this sender.
const SENDER_NAME = 'scrolltest-' + Date.now()
const SENDER_ID = 'fleet:' + SENDER_NAME
let fleetWs = null
let wsMsgId = 1

function connectFleet() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { rejectUnauthorized: false })
    const timer = setTimeout(() => reject(new Error('fleet WS connect timeout')), 8000)
    ws.on('open', () => {
      clearTimeout(timer)
      fleetWs = ws
      // Register the sender so it's a known agent (for register, `id` IS the
      // agent id — matches eliza.mjs's register shape).
      ws.send(JSON.stringify({ type: 'register', id: SENDER_ID, name: SENDER_NAME, cwd: process.cwd(), labels: ['bot', 'scroll-test'], human: false }))
      resolve(ws)
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function sendChat(from, to, text) {
  if (!fleetWs || fleetWs.readyState !== WebSocket.OPEN) throw new Error('fleet WS not open')
  fleetWs.send(JSON.stringify({ id: wsMsgId++, type: 'chat', from, to, message: text }))
}

// Send a message that matches the chat shape's filter (recipient friendly_name = tlda-ops).
function sendTestMessage(text) {
  sendChat(SENDER_ID, 'fleet:cf397d07', text)
}

async function getScrollState(page) {
  return page.evaluate(() => {
    // Find the chat log with the most messages (skip empty ones)
    const els = document.querySelectorAll('.fleet-chat-log')
    let best = null, bestCount = -1
    for (const el of els) {
      const count = el.querySelectorAll('.chat-line').length
      if (count > bestCount || (count === bestCount && el.scrollHeight > (best?.scrollHeight || 0))) {
        best = el; bestCount = count
      }
    }
    if (!best) return null
    return {
      scrollTop: best.scrollTop,
      scrollHeight: best.scrollHeight,
      clientHeight: best.clientHeight,
      distFromBottom: best.scrollHeight - best.scrollTop - best.clientHeight,
      msgCount: bestCount
    }
  })
}

async function scrollUp(page, pixels = 200) {
  await page.evaluate((px) => {
    const els = document.querySelectorAll('.fleet-chat-log')
    let best = null, bestCount = -1
    for (const el of els) {
      const c = el.querySelectorAll('.chat-line').length
      if (c > bestCount) { best = el; bestCount = c }
    }
    if (best) best.scrollTop -= px
  }, pixels)
}

async function scrollToBottom(page) {
  await page.evaluate(() => {
    const els = document.querySelectorAll('.fleet-chat-log')
    let best = null, bestCount = -1
    for (const el of els) {
      const c = el.querySelectorAll('.chat-line').length
      if (c > bestCount) { best = el; bestCount = c }
    }
    if (best) best.scrollTop = best.scrollHeight
  })
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForMsgCount(page, count, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const state = await getScrollState(page)
    if (state && state.msgCount >= count) return state
    await sleep(200)
  }
  return getScrollState(page)
}

// --- Test runner ---
let passed = 0, failed = 0
function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.log(`  ✗ ${name} ${detail}`)
    failed++
  }
}

// Poll until distFromBottom settles below `limit` (content reflow finished),
// or `timeout` elapses. Returns the final state either way.
async function waitForReflowSettled(page, limit, timeout = 4000) {
  const start = Date.now()
  let state = await getScrollState(page)
  while (Date.now() - start < timeout) {
    state = await getScrollState(page)
    if (state && state.distFromBottom < limit) return state
    await sleep(200)
  }
  return state
}

async function run() {
  console.log('Scroll Playback Test')
  console.log(`mode: ${MODE}`)
  console.log('====================\n')

  console.log('Connecting to fleet WS…')
  await connectFleet()
  await sleep(500) // let registration land

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ recordVideo: { dir: `/tmp/scroll-test-video-${MODE}/` }, ignoreHTTPSErrors: true })
  const page = await context.newPage()

  // Set scroll-mode before the app boots so FleetChatShape reads it at mount.
  await context.addInitScript((mode) => {
    try { localStorage.setItem('scroll-mode', mode) } catch {}
  }, MODE)

  const url = `https://localhost:${PORT}/?doc=${DOC}&name=scroll-tester&token=${TOKEN}&pw=1`
  console.log(`Opening ${url}\n`)
  await page.goto(url)

  // Create fleet HUD layout with properly-sized panels
  console.log('Waiting for editor to mount...')
  await page.waitForFunction(() => !!window.__tldraw_editor__, { timeout: 45000 })
    .catch(() => console.log('  (editor global not seen within 45s — continuing)'))
  await sleep(2000)
  const hasChat = await page.evaluate(() => document.querySelectorAll('.fleet-chat-log').length > 0)
  if (!hasChat) {
    console.log('Creating fleet layout...')
    await page.evaluate((senderName) => {
      const editor = window.__tldraw_editor__
      if (!editor) throw new Error('no editor')
      const chatW = 410, chatH = 500, agentsW = 340, agentsH = 330, gap = 10
      const pages = editor.getCurrentPageShapes().filter(s => s.type === 'svg-page')
      let ax = -900, ay = 0
      if (pages.length > 0) {
        const b = editor.getShapePageBounds(pages[0].id)
        if (b) { ax = b.x - chatW * 2 - agentsW - gap * 3; ay = b.y }
      }
      // Filter to this run's unique sender → chat starts EMPTY (no backlog).
      const testFilter = [[['from', senderName]]]
      editor.createShapes([
        { id: 'shape:fleet-agents-test', type: 'fleet-agents', x: ax, y: ay, props: { w: agentsW, h: agentsH } },
        { id: 'shape:fleet-chat-1', type: 'fleet-chat', x: ax + agentsW + gap, y: ay, props: { w: chatW, h: chatH, filter: testFilter } },
      ])
      localStorage.setItem('fleet-hud-expanded', '1')
      window.dispatchEvent(new CustomEvent('fleet-hud-toggle'))
    }, SENDER_NAME)
    await sleep(3000)
  }
  // Pan camera to show fleet shapes (they're positioned to the left of the document)
  await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    if (!editor) return
    const fleetShapes = editor.getCurrentPageShapes().filter(s => ['fleet-chat','fleet-agents'].includes(s.type))
    if (fleetShapes.length === 0) return
    const bounds = fleetShapes.map(s => editor.getShapePageBounds(s.id)).filter(Boolean)
    const minX = Math.min(...bounds.map(b => b.x))
    const minY = Math.min(...bounds.map(b => b.y))
    editor.setCamera({ x: -minX + 50, y: -minY + 50, z: 1 })
  })
  await sleep(1000)
  console.log('Fleet layout ready — camera panned to fleet shapes')

  // Wait for fleet-chat-log to appear (use 'attached' — HUD renders may not be 'visible' by playwright's definition)
  console.log('Waiting for chat log...')
  await page.waitForSelector('.fleet-chat-log', { timeout: 30000, state: 'attached' })
  await sleep(4000) // let initial messages load and scroll settle

  // --- Test 1: Initial load scrolls to bottom ---
  console.log('\n[Test 1] Initial load scrolls to bottom')
  await page.screenshot({ path: 'scratch/scroll-step-1-initial.png' })
  let state = await getScrollState(page)
  assert('chat log exists', state !== null)
  if (state) {
    assert('scrolled to bottom on load', state.distFromBottom < 50,
      `dist=${state.distFromBottom}`)
  }

  // --- Test 2: New messages keep scroll at bottom ---
  console.log('\n[Test 2] New messages auto-scroll to bottom')
  const beforeCount = state?.msgCount || 0
  for (let i = 0; i < 5; i++) {
    await sendTestMessage(`Test message ${i + 1} - ${Date.now()}`)
    await sleep(500)
  }
  state = await waitForMsgCount(page, beforeCount + 5)
  assert('messages arrived', state && state.msgCount >= beforeCount + 5,
    `expected >=${beforeCount + 5}, got ${state?.msgCount}`)
  await page.screenshot({ path: 'scratch/scroll-step-2-new-messages.png' })
  assert('still at bottom after new messages', state && state.distFromBottom < 30,
    `dist=${state?.distFromBottom}`)

  // --- Test 3: User can scroll up ---
  console.log('\n[Test 3] User can scroll up')
  await scrollUp(page, 300)
  await sleep(500)
  state = await getScrollState(page)
  await page.screenshot({ path: 'scratch/scroll-step-3-scrolled-up.png' })
  assert('scrolled up successfully', state && state.distFromBottom > 100,
    `dist=${state?.distFromBottom}`)

  // --- Test 4: New messages while scrolled up don't force scroll ---
  console.log('\n[Test 4] New messages while scrolled up preserve position')
  const scrollPosBefore = state?.scrollTop
  for (let i = 0; i < 3; i++) {
    await sendTestMessage(`Message while scrolled up ${i + 1}`)
    await sleep(500)
  }
  await sleep(1000)
  state = await getScrollState(page)
  await page.screenshot({ path: 'scratch/scroll-step-4-preserved.png' })
  assert('scroll position preserved while scrolled up',
    state && state.distFromBottom > 50,
    `dist=${state?.distFromBottom}, scrollTop before=${scrollPosBefore} after=${state?.scrollTop}`)

  // --- Test 5: Scrolling back to bottom re-enables auto-scroll ---
  console.log('\n[Test 5] Scroll to bottom re-enables auto-scroll')
  await scrollToBottom(page)
  await sleep(500)
  state = await getScrollState(page)
  assert('at bottom after manual scroll down', state && state.distFromBottom < 30,
    `dist=${state?.distFromBottom}`)

  // Send more messages — should auto-scroll
  for (let i = 0; i < 3; i++) {
    await sendTestMessage(`Post-scroll-back message ${i + 1}`)
    await sleep(500)
  }
  await sleep(1000)
  state = await getScrollState(page)
  await page.screenshot({ path: 'scratch/scroll-step-5-resumed.png' })
  assert('auto-scroll resumed after returning to bottom', state && state.distFromBottom < 30,
    `dist=${state?.distFromBottom}`)

  // --- Test 6: in-place growth (late content) while at bottom keeps you pinned ---
  // We are at bottom from Test 5. Send complex messages whose markdown/KaTeX/image
  // reflow AFTER the row mounts — the real failure trigger. We should stay pinned.
  console.log('\n[Test 6] In-place growth while at bottom keeps you pinned')
  for (let i = 0; i < 3; i++) {
    await sendTestMessage(complexMessage(i + 1))
    await sleep(700)
  }
  // Poll while the late image/math reflow happens — assert we settle at bottom.
  state = await waitForReflowSettled(page, 30, 4000)
  await page.screenshot({ path: 'scratch/scroll-step-6-inplace-growth.png' })
  assert('still pinned after late-loading complex content', state && state.distFromBottom < 30,
    `dist=${state?.distFromBottom}`)

  // --- Test 7: complex new message while scrolled up does NOT yank to bottom ---
  console.log('\n[Test 7] Complex message while scrolled up preserves position')
  await scrollUp(page, 300)
  await sleep(500)
  state = await getScrollState(page)
  assert('scrolled up before complex send', state && state.distFromBottom > 100,
    `dist=${state?.distFromBottom}`)
  const scrollPosBeforeComplex = state?.scrollTop
  for (let i = 0; i < 2; i++) {
    await sendTestMessage(complexMessage(100 + i))
    await sleep(700)
  }
  // Give reflow a moment; position must stay up, NOT yank to bottom.
  await sleep(2000)
  state = await getScrollState(page)
  await page.screenshot({ path: 'scratch/scroll-step-7-complex-scrolled-up.png' })
  assert('complex message did NOT yank to bottom while scrolled up',
    state && state.distFromBottom > 50,
    `dist=${state?.distFromBottom}, scrollTop before=${scrollPosBeforeComplex} after=${state?.scrollTop}`)

  // --- Summary ---
  console.log(`\n====================`)
  console.log(`[mode=${MODE}] Results: ${passed} passed, ${failed} failed`)

  await context.close() // flush video
  await browser.close()
  try { fleetWs?.close() } catch {}

  console.log(`\nVideo saved to /tmp/scroll-test-video-${MODE}/`)
  process.exit(failed > 0 ? 1 : 0)
}

run().catch(err => { console.error(err); process.exit(1) })
