import { chromium } from 'playwright'

const URL = 'http://localhost:5176/?doc=spinoff3&name=hl-test'

async function run() {
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext({ recordVideo: { dir: '/tmp/hl-before-video/' } })
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 1280, height: 800 })

  console.log('Opening page...')
  await page.goto(URL)

  // Wait for TLDraw editor to mount
  console.log('Waiting for editor...')
  await page.waitForFunction(() => !!window.__tldraw_editor__, { timeout: 30000 })
  console.log('Editor mounted')

  await page.waitForTimeout(2000)

  // Create a highlight shape with empty segments — the crash trigger
  console.log('Creating bad highlight shape...')
  const result = await page.evaluate(() => {
    try {
      const editor = window.__tldraw_editor__
      editor.createShape({
        type: 'highlight',
        x: 400,
        y: 300,
        props: {
          segments: [],
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
      return 'error: ' + e.message
    }
  })
  console.log('Result:', result)

  await page.waitForTimeout(2000)

  // Check for crash modal
  const modal = await page.$('text=Something went wrong')
  console.log('Crash modal present:', !!modal)

  await page.screenshot({ path: '/tmp/hl-before.png' })
  console.log('Screenshot saved to /tmp/hl-before.png')

  await page.waitForTimeout(2000)
  await ctx.close()
  await browser.close()
}

run().catch(e => { console.error(e); process.exit(1) })
