import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(3000)

// Intercept console.error to capture raw args
await page.evaluate(() => {
  const orig = console.error
  window.__errorArgs = []
  console.error = function(...args) {
    // Capture the raw args
    window.__errorArgs.push(args.map(a => {
      try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a) }
      catch(e) { return '[circular]' }
    }))
    orig.apply(console, args)
  }
})

// Create shape
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const vp = ed.getViewportPageBounds()
  ed.run(() => {
    ed.createShape({
      id: 'shape:tasks-debug-2',
      type: 'fleet-tasks',
      x: vp.x + 100,
      y: vp.y + 100,
      props: { w: 340, h: 420 },
    })
  }, { history: 'ignore' })
})

await page.waitForTimeout(1000)

// Get captured errors
const errorArgs = await page.evaluate(() => window.__errorArgs)
const hookErrors = errorArgs.filter(args => args.some(a => a.includes('Rendered fewer')))
hookErrors.forEach((args, i) => {
  console.log(`\n=== Error ${i} (${args.length} args) ===`)
  args.forEach((a, j) => {
    console.log(`  arg[${j}]: ${a.slice(0, 600)}`)
  })
})

await browser.close()
