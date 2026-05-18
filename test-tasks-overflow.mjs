import { chromium } from 'playwright'
const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(3000)

// Open overflow
const moreBtn = await page.$('[data-testid="tools.more-button"]')
await page.evaluate(el => el.click(), moreBtn)
await page.waitForTimeout(400)

// Check fleet-tasks in overflow
const fleetTasksBtn = await page.$('[data-testid="tools.fleet-tasks"]')
console.log('fleet-tasks in overflow:', fleetTasksBtn ? 'YES' : 'NO')

// Screenshot with overflow open
await page.screenshot({ path: `${OUT}/ts-overflow-open.png` })
console.log('ts-overflow-open.png')

// Click fleet-tasks tool
if (fleetTasksBtn) {
  await page.evaluate(el => el.click(), fleetTasksBtn)
  await page.waitForTimeout(300)
  
  // Place shape by clicking canvas
  await page.evaluate(() => {
    const ed = window.__tldraw_editor__
    console.log('current tool:', ed.getCurrentToolId())
    const vp = ed.getViewportPageBounds()
    const pt = { x: vp.x + vp.w * 0.7, y: vp.y + vp.h * 0.2 }
    const sc = ed.pageToScreen(pt)
    const canvas = document.querySelector('.tl-canvas')
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: sc.x, clientY: sc.y, bubbles: true, pointerId: 1 }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: sc.x, clientY: sc.y, bubbles: true, pointerId: 1 }))
  })
  await page.waitForTimeout(1500)
  
  const placed = await page.evaluate(() => {
    return window.__tldraw_editor__.getCurrentPageShapes().filter(s => s.type === 'fleet-tasks').length
  })
  console.log('fleet-tasks shapes placed:', placed)
  
  await page.screenshot({ path: `${OUT}/ts-placed-from-toolbar.png` })
  console.log('ts-placed-from-toolbar.png')
}

await browser.close()
