import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

// Capture full error details
const errors = []
page.on('console', m => {
  if (m.type() === 'error') {
    errors.push(m.text())
  }
})

// Intercept unhandled errors
page.on('pageerror', err => {
  errors.push(`PAGE ERROR: ${err.message}\n${err.stack}`)
})

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(3000)

// Inject error capture before creating shape
await page.evaluate(() => {
  const origError = console.error
  console.error = (...args) => {
    // Capture formatted args
    window.__lastError = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' | ')
    origError(...args)
  }
})

// Create shape
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const vp = ed.getViewportPageBounds()
  ed.run(() => {
    ed.createShape({
      id: 'shape:tasks-debug-1',
      type: 'fleet-tasks',
      x: vp.x + 100,
      y: vp.y + 100,
      props: { w: 340, h: 420 },
    })
  }, { history: 'ignore' })
})

await page.waitForTimeout(1000)

const lastError = await page.evaluate(() => window.__lastError || 'none')
console.log('Last error:', lastError.slice(0, 500))

// Get the React fiber tree to see what component is failing
const componentInfo = await page.evaluate(() => {
  // Find any element with a react fiber
  const el = document.querySelector('.fleet-tasks-shape') 
  if (!el) return 'no fleet-tasks-shape element'
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber'))
  if (!key) return 'no react fiber'
  return 'has fiber'
})
console.log('Component info:', componentInfo)

console.log('\nAll errors:')
errors.forEach(e => {
  const relevant = e.split('\n').slice(0,10).join('\n')
  if (!relevant.includes('9876') && !relevant.includes('403')) {
    console.log('---\n', relevant)
  }
})

await browser.close()
