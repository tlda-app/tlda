import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(3000)

// Create shape
const shapeId = `shape:fleet-tasks-shots-${Date.now()}`
await page.evaluate((id) => {
  const ed = window.__tldraw_editor__
  const vp = ed.getViewportPageBounds()
  ed.run(() => {
    ed.createShape({
      id,
      type: 'fleet-tasks',
      x: vp.x + vp.w * 0.6,
      y: vp.y + vp.h * 0.05,
      props: { w: 340, h: 500 },
    })
  }, { history: 'ignore' })
}, shapeId)

await page.waitForTimeout(1500)

// Get DOM info
const domInfo = await page.evaluate(() => {
  const shape = document.querySelector('.fleet-tasks-shape')
  if (!shape) return null
  const rows = [...shape.querySelectorAll('.fleet-tasks-row')]
  const tabs = [...shape.querySelectorAll('.fleet-tasks-tab')].map(t => t.textContent.trim())
  const footer = shape.querySelector('.fleet-tasks-footer')?.textContent?.trim()
  const sampleRows = rows.slice(0, 5).map(r => ({
    agent: r.querySelector('.fleet-tasks-agent-pill')?.textContent?.trim(),
    desc: r.querySelector('.fleet-tasks-desc')?.textContent?.trim(),
    status: r.querySelector('.fleet-tasks-status-badge')?.textContent?.trim(),
    age: r.querySelector('.fleet-tasks-col-age')?.textContent?.trim(),
  }))
  return { tabs, footer, rowCount: rows.length, sampleRows }
})
console.log('DOM:', JSON.stringify(domInfo, null, 2))

// Get bounding rect of just the shape
const rect = await page.evaluate((id) => {
  const ed = window.__tldraw_editor__
  const shape = ed.getShape(id)
  if (!shape) return null
  // Zoom to the shape with some padding
  const bounds = ed.getShapePageBounds(id)
  if (!bounds) return null
  // Set camera to frame the shape tightly
  ed.zoomToBounds(bounds, { animation: { duration: 0 }, inset: 20 })
  return bounds
}, shapeId)
console.log('Shape bounds:', rect)
await page.waitForTimeout(800)

// Screenshot — active tab
await page.screenshot({ path: `${OUT}/ts-active-tab.png` })
console.log('ts-active-tab.png')

// Get shape el bounding rect and crop to it
const shapeBounds = await page.evaluate(() => {
  const el = document.querySelector('.fleet-tasks-shape')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
})
console.log('Shape screen rect:', shapeBounds)

if (shapeBounds) {
  await page.screenshot({
    path: `${OUT}/ts-active-crop.png`,
    clip: {
      x: Math.max(0, shapeBounds.x - 10),
      y: Math.max(0, shapeBounds.y - 10),
      width: shapeBounds.width + 20,
      height: shapeBounds.height + 20,
    }
  })
  console.log('ts-active-crop.png')
}

// Click "done" tab
await page.evaluate(() => {
  const doneTab = [...document.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('done'))
  if (doneTab) doneTab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(400)
if (shapeBounds) {
  await page.screenshot({
    path: `${OUT}/ts-done-crop.png`,
    clip: { x: Math.max(0, shapeBounds.x - 10), y: Math.max(0, shapeBounds.y - 10), width: shapeBounds.width + 20, height: shapeBounds.height + 20 }
  })
  console.log('ts-done-crop.png')
}

// Back to "all" tab
await page.evaluate(() => {
  const allTab = [...document.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('all'))
  if (allTab) allTab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(400)
if (shapeBounds) {
  await page.screenshot({
    path: `${OUT}/ts-all-crop.png`,
    clip: { x: Math.max(0, shapeBounds.x - 10), y: Math.max(0, shapeBounds.y - 10), width: shapeBounds.width + 20, height: shapeBounds.height + 20 }
  })
  console.log('ts-all-crop.png')
}

await browser.close()
