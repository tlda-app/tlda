// Test that persisted state loads correctly
import puppeteer from 'puppeteer'

async function test() {
  console.log('Launching browser...')
  const browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()

  page.on('console', msg => console.log('[Browser]', msg.text()))

  console.log('Loading app (should restore from sync)...')
  await page.goto('http://localhost:5173/?doc=bregman&room=test-sync')

  await page.waitForFunction(() => window.__tldraw_editor__, { timeout: 10000 })
  console.log('TLDraw loaded')

  // Wait for Yjs to sync
  await new Promise(r => setTimeout(r, 3000))

  // Get shapes - should include the rectangle from previous test
  const shapes = await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    const shapes = editor.getCurrentPageShapes()
    return shapes.map(s => ({ type: s.type, x: Math.round(s.x), y: Math.round(s.y) }))
  })

  console.log(`\nLoaded ${shapes.length} shapes`)

  // Find our test rectangle
  const testRect = shapes.find(s => s.type === 'geo' && s.x === 100 && s.y === 100)
  if (testRect) {
    console.log('✓ Test rectangle persisted and loaded!')
  } else {
    console.log('✗ Test rectangle not found')
    console.log('Geo shapes:', shapes.filter(s => s.type === 'geo'))
  }

  await browser.close()
}

test().catch(e => {
  console.error('Test failed:', e)
  process.exit(1)
})
