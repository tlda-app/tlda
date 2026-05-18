import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 500, height: 580 } })

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(3000)

const shapeId = `shape:fleet-tasks-vp-${Date.now()}`

// Place shape in blank canvas area (well below all document pages)
await page.evaluate((id) => {
  const ed = window.__tldraw_editor__
  ed.run(() => {
    ed.createShape({
      id,
      type: 'fleet-tasks',
      x: 0,
      y: 50000,  // way below all pages
      props: { w: 340, h: 500 },
    })
  }, { history: 'ignore' })
  const bounds = ed.getShapePageBounds(id)
  if (bounds) ed.zoomToBounds(bounds, { animation: { duration: 0 }, inset: 20 })
}, shapeId)

await page.waitForTimeout(1500)

// Get shape screen position
const screenPos = await page.evaluate(() => {
  const el = document.querySelector('.fleet-tasks-shape')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
})
console.log('Screen pos:', screenPos)

// Active tab screenshot (full viewport, shape in center)
await page.screenshot({ path: `${OUT}/ts-vp-active.png` })
console.log('ts-vp-active.png')

// Done tab
await page.evaluate(() => {
  const done = [...document.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('done'))
  done?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/ts-vp-done.png` })
console.log('ts-vp-done.png')

// All tab
await page.evaluate(() => {
  const all = [...document.querySelectorAll('.fleet-tasks-tab')].find(t => t.textContent.trim().startsWith('all'))
  all?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/ts-vp-all.png` })
console.log('ts-vp-all.png')

await browser.close()
