import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 420, height: 560 } })

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(3000)

// Place shape far to the right of the document to avoid PDF bleed
const shapeId = `shape:fleet-tasks-final-${Date.now()}`
await page.evaluate((id) => {
  const ed = window.__tldraw_editor__
  // Place far right where there's no document content
  ed.run(() => {
    ed.createShape({
      id,
      type: 'fleet-tasks',
      x: 5000,
      y: 0,
      props: { w: 340, h: 500 },
    })
  }, { history: 'ignore' })
  const bounds = ed.getShapePageBounds(id)
  if (bounds) ed.zoomToBounds(bounds, { animation: { duration: 0 }, inset: 10 })
}, shapeId)

await page.waitForTimeout(1500)

const shapeEl = await page.$('.fleet-tasks-shape')
if (!shapeEl) { console.log('no shape'); await browser.close(); process.exit(1) }

// Active tab (default)
await shapeEl.screenshot({ path: `${OUT}/ts-final-active.png` })
console.log('ts-final-active.png')

// Done tab
await page.evaluate(() => {
  const done = [...document.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('done'))
  done?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(400)
await shapeEl.screenshot({ path: `${OUT}/ts-final-done.png` })
console.log('ts-final-done.png')

// All tab + sort by status
await page.evaluate(() => {
  const all = [...document.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('all'))
  all?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(300)
await page.evaluate(() => {
  document.querySelector('.fleet-tasks-sort-btn')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(300)
await shapeEl.screenshot({ path: `${OUT}/ts-final-sort.png` })
console.log('ts-final-sort.png')

await browser.close()
