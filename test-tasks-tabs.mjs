import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 500, height: 580 } })

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(5000)

const shapeId = `shape:fleet-tasks-tabs-${Date.now()}`
await page.evaluate((id) => {
  const ed = window.__tldraw_editor__
  ed.run(() => {
    ed.createShape({ id, type: 'fleet-tasks', x: 0, y: 50000, props: { w: 340, h: 500 } })
  }, { history: 'ignore' })
  const bounds = ed.getShapePageBounds(id)
  if (bounds) ed.zoomToBounds(bounds, { animation: { duration: 0 }, inset: 20 })
}, shapeId)
await page.waitForTimeout(3000)

// Get the specific shape's tabs (by finding its container via data attribute or position)
// We need the LAST created shape's tabs since there may be old ones
const shapeElHandle = await page.evaluateHandle((id) => {
  const ed = window.__tldraw_editor__
  const shapeEl = document.querySelector(`[data-shape-id="${id}"]`)
  return shapeEl?.querySelector('.fleet-tasks-shape') || null
}, shapeId)

// Since we can't easily target a specific shape's tabs, use the last shape's tabs
// All shapes have same data so it doesn't matter which one we screenshot

// Done tab — click in first visible shape
await page.evaluate(() => {
  // Find the first visible .fleet-tasks-shape and its done tab
  const shapes = document.querySelectorAll('.fleet-tasks-shape')
  const last = shapes[shapes.length - 1]  // most recently added
  if (last) {
    const done = [...last.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('done'))
    done?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  }
})
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/ts-done-tab.png` })
console.log('ts-done-tab.png')

// All tab, sorted by status
await page.evaluate(() => {
  const shapes = document.querySelectorAll('.fleet-tasks-shape')
  const last = shapes[shapes.length - 1]
  if (last) {
    const all = [...last.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('all'))
    all?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  }
})
await page.waitForTimeout(300)
await page.evaluate(() => {
  const shapes = document.querySelectorAll('.fleet-tasks-shape')
  const last = shapes[shapes.length - 1]
  last?.querySelector('.fleet-tasks-sort-btn')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/ts-sorted-status.png` })
console.log('ts-sorted-status.png — all tab, sorted by status')

await browser.close()
