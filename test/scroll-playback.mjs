#!/usr/bin/env node
/**
 * Scroll Playback Test
 *
 * Replays real chat events through a fleet-chat shape in a headed browser,
 * verifying scroll invariants at each step.
 *
 * Usage:
 *   node test/scroll-playback.mjs [--doc test-scroll] [--port 5184]
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
 */

import { chromium } from 'playwright'

const DOC = process.argv.includes('--doc') ? process.argv[process.argv.indexOf('--doc') + 1] : 'test-scroll'
const PORT = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '5184'
const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c'
const FLEET_API = 'http://localhost:5176'

async function sendChat(from, to, text) {
  const res = await fetch(`${FLEET_API}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, from, to })
  })
  return res.json()
}

// Send a message that matches the chat filter (from/to tlda-ops)
async function sendTestMessage(text) {
  return sendChat('fleet:scroll-test-agent', 'fleet:cf397d07', text)
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

async function run() {
  console.log('Scroll Playback Test')
  console.log('====================\n')

  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ recordVideo: { dir: '/tmp/scroll-test-video/' } })
  const page = await context.newPage()

  const url = `http://localhost:${PORT}/?doc=${DOC}&name=scroll-tester&token=${TOKEN}`
  console.log(`Opening ${url}\n`)
  await page.goto(url)

  // Create fleet HUD layout with properly-sized panels
  console.log('Waiting for page to load...')
  await sleep(5000)
  const hasChat = await page.evaluate(() => document.querySelectorAll('.fleet-chat-log').length > 0)
  if (!hasChat) {
    console.log('Creating fleet layout...')
    await page.evaluate(() => {
      const editor = window.__tldraw_editor__
      if (!editor) throw new Error('no editor')
      const chatW = 410, chatH = 500, agentsW = 340, agentsH = 330, gap = 10
      const pages = editor.getCurrentPageShapes().filter(s => s.type === 'svg-page')
      let ax = -900, ay = 0
      if (pages.length > 0) {
        const b = editor.getShapePageBounds(pages[0].id)
        if (b) { ax = b.x - chatW * 2 - agentsW - gap * 3; ay = b.y }
      }
      // Use a real filter — empty filter shows nothing
      const testFilter = [[['from', 'tlda-ops']], [['to', 'tlda-ops']]]
      editor.createShapes([
        { id: 'shape:fleet-agents-test', type: 'fleet-agents', x: ax, y: ay, props: { w: agentsW, h: agentsH } },
        { id: 'shape:fleet-chat-1', type: 'fleet-chat', x: ax + agentsW + gap, y: ay, props: { w: chatW, h: chatH, filter: testFilter } },
      ])
      localStorage.setItem('fleet-hud-expanded', '1')
      window.dispatchEvent(new CustomEvent('fleet-hud-toggle'))
    })
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

  // --- Summary ---
  console.log(`\n====================`)
  console.log(`Results: ${passed} passed, ${failed} failed`)

  await context.close() // flush video
  await browser.close()

  console.log(`\nVideo saved to /tmp/scroll-test-video/`)
  process.exit(failed > 0 ? 1 : 0)
}

run().catch(err => { console.error(err); process.exit(1) })
