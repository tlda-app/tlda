import { chromium } from 'playwright'
const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'
const browser = await chromium.launch({ headless: true })

// 1. Overflow menu close-up
{
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
  await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
  await page.waitForTimeout(3000)
  const moreBtn = await page.$('[data-testid="tools.more-button"]')
  await page.evaluate(el => el.click(), moreBtn)
  await page.waitForTimeout(500)
  
  // Find the overflow content area and crop to it
  const overflowBounds = await page.evaluate(() => {
    const mc = document.querySelector('[data-testid="tools.more-content"]')
    if (!mc) return null
    const r = mc.getBoundingClientRect()
    // Get the toolbar + overflow combined
    const toolbar = document.querySelector('.tlui-toolbar')
    const tr = toolbar?.getBoundingClientRect()
    return { x: tr?.left || 0, y: tr?.top || 0, w: (tr?.width || 120) + r.width + 20, h: Math.max(r.height, tr?.height || 400) + 40 }
  })
  console.log('Overflow bounds:', overflowBounds)
  
  // Screenshot with the toolbar + overflow visible
  if (overflowBounds) {
    await page.screenshot({
      path: `${OUT}/ts-toolbar-overflow.png`,
      clip: { x: 0, y: 0, width: 200, height: 900 }
    })
    console.log('ts-toolbar-overflow.png')
  }
  await page.close()
}

// 2. Shape with real data — zoomed close-up
{
  const page = await browser.newPage({ viewport: { width: 500, height: 580 } })
  await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
  await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
  await page.waitForTimeout(5000)
  
  // Use toolbar to place shape
  const moreBtn = await page.$('[data-testid="tools.more-button"]')
  await page.evaluate(el => el.click(), moreBtn)
  await page.waitForTimeout(400)
  const tasksBtn = await page.$('[data-testid="tools.fleet-tasks"]')
  await page.evaluate(el => el.click(), tasksBtn)
  await page.waitForTimeout(200)
  
  // Place below document
  await page.evaluate(() => {
    const ed = window.__tldraw_editor__
    const vp = ed.getViewportPageBounds()
    const pt = ed.pageToScreen({ x: vp.x + vp.w * 0.5, y: vp.y + vp.h * 0.5 })
    const canvas = document.querySelector('.tl-canvas')
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: pt.x, clientY: pt.y, bubbles: true, pointerId: 1 }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: pt.x, clientY: pt.y, bubbles: true, pointerId: 1 }))
  })
  await page.waitForTimeout(3000)
  
  // Zoom to just the shape
  await page.evaluate(() => {
    const ed = window.__tldraw_editor__
    const shapes = ed.getCurrentPageShapes().filter(s => s.type === 'fleet-tasks')
    if (shapes.length) {
      const id = shapes[shapes.length - 1].id
      const b = ed.getShapePageBounds(id)
      if (b) {
        // Place camera so shape fills 80% of viewport
        ed.zoomToBounds(b, { animation: { duration: 0 }, inset: 30 })
      }
    }
  })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/ts-shape-final.png` })
  console.log('ts-shape-final.png')
  await page.close()
}

await browser.close()
