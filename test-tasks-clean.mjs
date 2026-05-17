import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 800, height: 700 } })

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(3000)

const shapeId = `shape:fleet-tasks-clean-${Date.now()}`
await page.evaluate((id) => {
  const ed = window.__tldraw_editor__
  // Center the shape in viewport
  ed.run(() => {
    ed.createShape({
      id,
      type: 'fleet-tasks',
      x: 0,
      y: 0,
      props: { w: 340, h: 500 },
    })
  }, { history: 'ignore' })
  // Zoom to fit this shape
  const bounds = ed.getShapePageBounds(id)
  if (bounds) ed.zoomToBounds(bounds, { animation: { duration: 0 }, inset: 50 })
}, shapeId)

await page.waitForTimeout(1500)

// Screenshot the shape element directly
const shapeEl = await page.$('.fleet-tasks-shape')
if (shapeEl) {
  await shapeEl.screenshot({ path: `${OUT}/ts-shape-active.png` })
  console.log('ts-shape-active.png — active tab')
  
  // Done tab
  await page.evaluate(() => {
    const done = [...document.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('done'))
    done?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  await page.waitForTimeout(400)
  await shapeEl.screenshot({ path: `${OUT}/ts-shape-done.png` })
  console.log('ts-shape-done.png — done tab')

  // Sort by status
  await page.evaluate(() => {
    const all = [...document.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('all'))
    all?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    const sortBtn = document.querySelector('.fleet-tasks-sort-btn')
    sortBtn?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  await shapeEl.screenshot({ path: `${OUT}/ts-shape-sort-status.png` })
  console.log('ts-shape-sort-status.png — all tab, sorted by status')
} else {
  console.log('Shape element not found')
}

await browser.close()
