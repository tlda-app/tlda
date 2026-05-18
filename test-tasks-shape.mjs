import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

const consoleErrors = []
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200))
})

console.log('Loading bregman...')
await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
console.log('Canvas mounted')
await page.waitForTimeout(3000)

await page.screenshot({ path: `${OUT}/ts-01-canvas.png` })
console.log('ts-01-canvas.png')

// Create shape with history:ignore to bypass Yjs sync
const createResult = await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  if (!ed) return 'no editor'
  try {
    const vp = ed.getViewportPageBounds()
    const x = vp.x + vp.w * 0.55
    const y = vp.y + vp.h * 0.1
    const id = `shape:fleet-tasks-test-${Date.now()}`
    ed.run(() => {
      ed.createShape({
        id,
        type: 'fleet-tasks',
        x,
        y,
        props: { w: 340, h: 420 },
      })
    }, { history: 'ignore' })
    const s = ed.getShape(id)
    return s ? `created ok: ${id}` : 'not found after create'
  } catch(e) {
    return `error: ${e.message}`
  }
})
console.log('Create result:', createResult)
await page.waitForTimeout(2000)

// Check if page crashed
const crashed = await page.evaluate(() => {
  return document.querySelector('[class*="something-wrong"], h1')?.textContent || 'no crash header'
})
console.log('Crash check:', crashed)

await page.screenshot({ path: `${OUT}/ts-02-after-create.png` })
console.log('ts-02-after-create.png')

// DOM inspection
const domInfo = await page.evaluate(() => {
  const shape = document.querySelector('.fleet-tasks-shape')
  if (!shape) return { found: false, allShapeClasses: [...document.querySelectorAll('[class*="fleet"]')].map(e => e.className).slice(0,5) }
  const rows = [...shape.querySelectorAll('.fleet-tasks-row')]
  const tabs = [...shape.querySelectorAll('.fleet-tasks-tab')].map(t => t.textContent.trim())
  const emptyMsg = shape.querySelector('.fleet-tasks-empty')?.textContent?.trim()
  const footer = shape.querySelector('.fleet-tasks-footer')?.textContent?.trim()
  return { found: true, rows: rows.length, tabs, emptyMsg, footer }
})
console.log('DOM:', JSON.stringify(domInfo, null, 2))

if (domInfo.found) {
  // Zoom to the shape
  await page.evaluate(() => {
    const ed = window.__tldraw_editor__
    const shapes = ed.getCurrentPageShapes().filter(s => s.type === 'fleet-tasks')
    if (shapes.length > 0) {
      const id = shapes[0].id
      ed.select(id)
      ed.zoomToSelection()
    }
  })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${OUT}/ts-03-zoomed.png` })
  console.log('ts-03-zoomed.png')

  // Click "all" tab
  await page.evaluate(() => {
    const allTab = [...document.querySelectorAll('.fleet-tasks-tab')]
      .find(t => t.textContent.trim().startsWith('all'))
    if (allTab) allTab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/ts-04-all-tab.png` })
  console.log('ts-04-all-tab.png')
}

console.log('Errors:', consoleErrors.filter(e => !e.includes('9876') && !e.includes('403')).slice(0,5))
await browser.close()
