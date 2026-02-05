// Test Yjs sync with Puppeteer
import puppeteer from 'puppeteer'
import { readFileSync, existsSync } from 'fs'

async function test() {
  console.log('Launching browser...')
  const browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()

  // Enable console logging
  page.on('console', msg => console.log('[Browser]', msg.text()))

  console.log('Loading app...')
  await page.goto('http://localhost:5173/?doc=bregman&room=test-fresh-' + Date.now())

  // Wait for TLDraw to load
  await page.waitForFunction(() => window.__tldraw_editor__, { timeout: 10000 })
  console.log('TLDraw loaded')

  // Wait for Yjs to connect
  await new Promise(r => setTimeout(r, 2000))

  // Create a test shape
  console.log('Creating test shape...')
  await page.evaluate(() => {
    const editor = window.__tldraw_editor__
    editor.createShape({
      type: 'geo',
      x: 100,
      y: 100,
      props: { geo: 'rectangle', w: 100, h: 100 }
    })
  })

  // Wait for sync
  await new Promise(r => setTimeout(r, 2000))

  // Check persistence file
  const dataFile = 'server/data/test-sync.yjs'
  if (existsSync(dataFile)) {
    const stats = readFileSync(dataFile)
    console.log(`✓ Persistence file created: ${stats.length} bytes`)
  } else {
    console.log('✗ Persistence file not found')
  }

  // Get shape count
  const shapeCount = await page.evaluate(() => {
    return window.__tldraw_editor__.getCurrentPageShapes().length
  })
  console.log(`Shapes on canvas: ${shapeCount}`)

  await browser.close()
  console.log('Done!')
}

test().catch(e => {
  console.error('Test failed:', e)
  process.exit(1)
})
