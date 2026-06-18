#!/usr/bin/env node
/**
 * brush-test — automated regression check for HUD brush selection.
 *
 * What it tests: in HUD layout-active mode, does dragging across a fleet
 * shape leave the overlay editor with that shape selected?
 *
 * Concrete pass/fail:
 *   1. Open test-fleet, set up 3-col layout, frame doc.
 *   2. Click "Resize / move" on fleet-agents → enters hud-layout-active,
 *      fleet-agents in .fleet-drag-mode (selected in overlay editor).
 *   3. PRECONDITION: hud-layout-active set, dragModeShapes contains agents.
 *   4. Drag from empty area (200,30) across the middle fleet-chat to (700,200).
 *   5. CHECK: after pointer-up, is *anything* in .fleet-drag-mode?
 *        - PASS: at least one shape is .fleet-drag-mode (brush selected something)
 *        - FAIL: nothing in .fleet-drag-mode (the bug — selection was cleared)
 *
 * Usage:
 *   node bin/brush-test.mjs            # tests current dist; PASS / FAIL exit 0/1
 *   node bin/brush-test.mjs --headed   # visible browser (for debugging)
 */
import { chromium } from 'playwright'
import { hasTls } from '../shared/config.mjs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Default to headed — never test UI behavior in a headless browser (real
// browsers and headless have different pointer/rendering semantics).
// Use --headless explicitly to override (only for fast bisect iteration
// after you've already verified the headed result matches the real-browser
// symptom).
const HEADED = !process.argv.includes('--headless')
const cfg = JSON.parse(readFileSync(join(homedir(), '.config', 'tlda', 'config.json'), 'utf8'))
const token = cfg.tokenRead || cfg.tokenRw || cfg.token

const browser = await chromium.launch({ headless: !HEADED })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
const page = await ctx.newPage()
page.on('pageerror', e => console.error('  [page error]', e.message))
await page.addInitScript(() => {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('fleet-') || k.startsWith('tldraw') || k.startsWith('TLDRAW')) localStorage.removeItem(k)
  }
  sessionStorage.clear()
  localStorage.setItem('fleet-hud-expanded', '1')
})
const url = `${hasTls ? 'https' : 'http'}://localhost:5176/?doc=test-fleet&name=tester&token=${token}`
await page.goto(url, { waitUntil: 'domcontentloaded' })

// Wait for editor + fleet shapes
await page.waitForFunction(() => {
  const ed = window.__tldraw_editor__
  if (!ed) return false
  const fleet = ed.getCurrentPageShapes().filter(s => ['fleet-chat','fleet-agents','fleet-search','fleet-docview'].includes(s.type))
  const docs = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page' || s.type === 'html-page')
  return fleet.length >= 4 && docs.length >= 1
}, null, { timeout: 30000 })

// Frame doc + reset HUD (mirrors tlda-test-setup.mjs)
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const docs = ed.getCurrentPageShapes()
    .filter(s => s.type === 'svg-page' || s.type === 'html-page')
    .sort((a, b) => {
      const ba = ed.getShapePageBounds(a.id), bb = ed.getShapePageBounds(b.id)
      return ba.y - bb.y || ba.x - bb.x
    })
  const b = ed.getShapePageBounds(docs[0].id)
  ed.zoomToBounds(b, { inset: 16, animation: { duration: 0 } })
  const cam = ed.getCamera()
  ed.setCamera({ x: 1220 / cam.z - b.x, y: cam.y, z: cam.z }, { animation: { duration: 0 } })
})
await page.waitForTimeout(400)
await page.evaluate(() => window.dispatchEvent(new Event('fleet-hud-reset')))
await page.waitForTimeout(800)

// Find ⊞ button on fleet-agents
const layoutBtn = await page.evaluate(() => {
  const btns = document.querySelectorAll('.fleet-hud-wrap [data-shape-type="fleet-agents"] .fleet-btn-group button[title="Resize / move"]')
  if (btns.length === 0) return null
  const r = btns[0].getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
if (!layoutBtn) {
  console.error('SETUP-FAIL: no Resize/move button found on fleet-agents')
  await browser.close()
  process.exit(2)
}
await page.mouse.click(layoutBtn.x, layoutBtn.y)
await page.waitForTimeout(400)

const pre = await page.evaluate(() => {
  const wrap = document.querySelector('.fleet-hud-wrap')
  return {
    layoutActive: wrap.classList.contains('hud-layout-active'),
    dragModeShapes: [...document.querySelectorAll('.fleet-drag-mode')].map(el => el.dataset.shapeId),
  }
})
if (!pre.layoutActive || pre.dragModeShapes.length === 0) {
  console.error('SETUP-FAIL: did not enter layout mode after clicking ⊞:', JSON.stringify(pre))
  await browser.close()
  process.exit(2)
}

// Brush from empty top area across the middle fleet-chat (which sits ~370-780 x, 100-836 y)
const start = { x: 200, y: 30 }
const end = { x: 700, y: 200 }
await page.mouse.move(start.x, start.y)
await page.mouse.down()
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(start.x + (end.x - start.x) * i / 10, start.y + (end.y - start.y) * i / 10)
  await page.waitForTimeout(15)
}
await page.mouse.up()
await page.waitForTimeout(500)

const post = await page.evaluate(() => {
  const wrap = document.querySelector('.fleet-hud-wrap')
  return {
    layoutActive: wrap.classList.contains('hud-layout-active'),
    dragModeShapes: [...document.querySelectorAll('.fleet-drag-mode')].map(el => el.dataset.shapeId),
  }
})

console.log('pre :', JSON.stringify(pre))
console.log('post:', JSON.stringify(post))

const pass = post.dragModeShapes.length > 0
console.log(pass ? 'PASS: brush left selection alive' : 'FAIL: brush cleared all selection (the regression)')
await browser.close()
process.exit(pass ? 0 : 1)
