import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c'
const DOC = 'test-fleet'
const URL = `http://localhost:5176/?doc=${DOC}&name=hl-tester&token=${TOKEN}`

mkdirSync('/tmp/hl-before-video', { recursive: true })

async function run() {
  console.log('Launching browser...')
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext({ recordVideo: { dir: '/tmp/hl-before-video/' } })
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 1280, height: 900 })

  // Catch uncaught errors
  page.on('pageerror', e => console.log('[PAGE ERROR]', e.message))
  page.on('console', m => { if (m.type() === 'error') console.log('[CONSOLE ERR]', m.text()) })

  console.log('Navigating to', URL)
  await page.goto(URL)

  // Wait for editor
  console.log('Waiting for editor to mount...')
  try {
    await page.waitForFunction(() => !!window.__tldraw_editor__, { timeout: 25000 })
    console.log('Editor mounted!')
  } catch(e) {
    console.log('Editor timeout. Taking screenshot...')
    await page.screenshot({ path: '/tmp/hl-before-state.png' })
    await ctx.close()
    await browser.close()
    return
  }

  await page.waitForTimeout(1000)

  // Create a highlight shape with empty segments — the crash trigger
  console.log('Creating highlight shape with empty segments...')
  const result = await page.evaluate(() => {
    try {
      const editor = window.__tldraw_editor__
      if (!editor) return 'editor not found'
      editor.createShape({
        type: 'highlight',
        x: 400,
        y: 300,
        props: {
          segments: [],   // empty → allPointsFromSegments=[] → getShapeDot(undefined)
          color: 'blue',
          size: 'm',
          isComplete: false,
          isPen: false,
          scale: 1,
          scaleX: 1,
          scaleY: 1,
        }
      })
      return 'shape created'
    } catch(e) {
      return 'create threw: ' + e.message
    }
  })
  console.log('Create result:', result)

  await page.waitForTimeout(2000)

  // Check for crash modal
  const crashModal = await page.$('text="Something went wrong"')
  console.log('Crash modal present:', !!crashModal)
  
  // Check for any error text on page
  const errorText = await page.evaluate(() => {
    const divs = [...document.querySelectorAll('div, p, h1, h2')]
    return divs.filter(el => el.textContent?.includes('went wrong') || el.textContent?.includes('error')).map(el => el.textContent?.trim().substring(0, 100)).filter(Boolean)
  })
  console.log('Error text on page:', errorText.slice(0, 3))

  await page.screenshot({ path: '/tmp/hl-before.png' })
  console.log('Screenshot at /tmp/hl-before.png')

  await page.waitForTimeout(1000)
  await ctx.close()
  await browser.close()
  console.log('Done')
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
