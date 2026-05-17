import { chromium } from 'playwright'
const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'
const browser = await chromium.launch({ headless: true })

const errors = []
const page = await browser.newPage({ viewport: { width: 500, height: 460 } })
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('403') && !m.text().includes('9876')) errors.push(m.text().slice(0,120)) })

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(4000)

// Check fleet-inbox in overflow
const moreBtn = await page.$('[data-testid="tools.more-button"]')
await page.evaluate(el => el.click(), moreBtn)
await page.waitForTimeout(400)
const inboxBtn = await page.$('[data-testid="tools.fleet-inbox"]')
console.log('fleet-inbox in overflow:', inboxBtn ? 'YES' : 'NO')

if (inboxBtn) {
  await page.evaluate(el => el.click(), inboxBtn)
  await page.waitForTimeout(200)
  // Place via tool
  await page.evaluate(() => {
    const ed = window.__tldraw_editor__
    const vp = ed.getViewportPageBounds()
    const pt = ed.pageToScreen({ x: vp.x + vp.w * 0.5, y: vp.y + vp.h * 0.5 })
    const c = document.querySelector('.tl-canvas')
    c.dispatchEvent(new PointerEvent('pointerdown', { clientX: pt.x, clientY: pt.y, bubbles: true, pointerId: 1 }))
    c.dispatchEvent(new PointerEvent('pointerup', { clientX: pt.x, clientY: pt.y, bubbles: true, pointerId: 1 }))
  })
  await page.waitForTimeout(2000)
  
  const shapeOk = await page.evaluate(() => {
    return window.__tldraw_editor__.getCurrentPageShapes().filter(s => s.type === 'fleet-inbox').length
  })
  console.log('fleet-inbox shapes:', shapeOk)
  
  const dom = await page.evaluate(() => {
    const s = document.querySelector('.fleet-inbox-shape')
    if (!s) return { found: false }
    return {
      found: true,
      title: s.querySelector('.fleet-inbox-title')?.textContent,
      empty: s.querySelector('.fleet-inbox-empty-text')?.textContent,
      count: s.querySelector('.fleet-inbox-count')?.textContent,
    }
  })
  console.log('DOM:', JSON.stringify(dom))
  
  // Zoom to shape and screenshot
  await page.evaluate(() => {
    const ed = window.__tldraw_editor__
    const shapes = ed.getCurrentPageShapes().filter(s => s.type === 'fleet-inbox')
    if (shapes.length) {
      const b = ed.getShapePageBounds(shapes[shapes.length-1].id)
      if (b) ed.zoomToBounds(b, { animation: { duration: 0 }, inset: 20 })
    }
  })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/inbox-empty.png` })
  console.log('inbox-empty.png')
}

if (errors.length) console.log('Errors:', errors)
await browser.close()
