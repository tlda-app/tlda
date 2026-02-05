// Test full sync roundtrip: create shapes, close, reopen, verify
import puppeteer from 'puppeteer'

const ROOM = 'roundtrip-' + Date.now()

async function test() {
  console.log(`Testing room: ${ROOM}\n`)

  // Session 1: Create a shape
  console.log('=== Session 1: Create shape ===')
  let browser = await puppeteer.launch({ headless: true })
  let page = await browser.newPage()
  page.on('console', msg => {
    if (msg.text().includes('[Yjs]')) console.log('[Browser]', msg.text())
  })

  await page.goto(`http://localhost:5173/?doc=bregman&room=${ROOM}`)
  await page.waitForFunction(() => window.__tldraw_editor__, { timeout: 10000 })
  await new Promise(r => setTimeout(r, 3000)) // Wait for sync

  let count = await page.evaluate(() => window.__tldraw_editor__.getCurrentPageShapes().length)
  console.log(`Shapes after load: ${count}`)

  await page.evaluate(() => {
    window.__tldraw_editor__.createShape({
      type: 'geo', x: 200, y: 200,
      props: { geo: 'ellipse', w: 80, h: 80 }
    })
  })
  await new Promise(r => setTimeout(r, 1000))

  count = await page.evaluate(() => window.__tldraw_editor__.getCurrentPageShapes().length)
  console.log(`Shapes after create: ${count}`)

  await browser.close()
  console.log('Session 1 closed\n')

  // Session 2: Reopen and verify
  console.log('=== Session 2: Verify persistence ===')
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  page.on('console', msg => {
    if (msg.text().includes('[Yjs]')) console.log('[Browser]', msg.text())
  })

  await page.goto(`http://localhost:5173/?doc=bregman&room=${ROOM}`)
  await page.waitForFunction(() => window.__tldraw_editor__, { timeout: 10000 })
  await new Promise(r => setTimeout(r, 3000))

  count = await page.evaluate(() => window.__tldraw_editor__.getCurrentPageShapes().length)
  console.log(`Shapes after reload: ${count}`)

  const hasEllipse = await page.evaluate(() => {
    return window.__tldraw_editor__.getCurrentPageShapes()
      .some(s => s.type === 'geo' && s.props?.geo === 'ellipse')
  })
  console.log(`Ellipse found: ${hasEllipse ? '✓' : '✗'}`)

  await browser.close()

  // Verdict
  console.log('\n=== Result ===')
  if (count === 44 && hasEllipse) {
    console.log('✓ PASS: No duplicates, persistence works')
  } else if (hasEllipse) {
    console.log(`⚠ Duplicates detected (${count} shapes, expected 44)`)
  } else {
    console.log('✗ FAIL: Shape not persisted')
  }
}

test().catch(e => {
  console.error('Test failed:', e)
  process.exit(1)
})
