import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const TOKEN = 'c5e4726ab77972fc7312f3a703f9cf1c'
const DOC = 'fleet-multi-chat-test'
const URL = `http://localhost:6100/?doc=${DOC}&name=hl-tester&token=${TOKEN}`

mkdirSync('/tmp/hl-after-video', { recursive: true })

async function run() {
  console.log('Launching browser for AFTER test...')
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext({ recordVideo: { dir: '/tmp/hl-after-video/' } })
  const page = await ctx.newPage()
  await page.setViewportSize({ width: 1280, height: 900 })

  page.on('pageerror', e => console.log('[PAGE ERROR]', e.message))
  page.on('console', m => {
    const t = m.text()
    if (m.type() === 'error' && !t.includes('favicon') && !t.includes('404')) 
      console.log('[CONSOLE ERR]', t.substring(0, 200))
    if (t.includes('tldraw') || t.includes('editor') || t.includes('mount'))
      console.log('[CONSOLE]', t.substring(0, 100))
  })

  console.log('Navigating to', URL)
  await page.goto(URL)

  console.log('Waiting for editor (30s)...')
  try {
    await page.waitForFunction(() => !!window.__tldraw_editor__, { timeout: 30000 })
    console.log('Editor mounted!')
  } catch(e) {
    // Take screenshot to see what's happening
    await page.screenshot({ path: '/tmp/hl-after-debug.png' })
    console.log('Editor timeout — screenshot at /tmp/hl-after-debug.png')
    console.log('Checking page DOM...')
    const dom = await page.evaluate(() => document.body.innerHTML.substring(0, 500))
    console.log('DOM:', dom)
    await ctx.close()
    await browser.close()
    return
  }

  await page.waitForTimeout(1000)

  console.log('Creating highlight shape with empty segments (SHOULD NOT CRASH with fix)...')
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
      return 'shape created without crash!'
    } catch(e) {
      return 'create threw: ' + e.message
    }
  })
  console.log('Result:', result)

  await page.waitForTimeout(2000)

  const crashModal = await page.$('text="Something went wrong"')
  console.log('Crash modal present:', !!crashModal)

  await page.screenshot({ path: '/tmp/hl-after.png' })
  console.log('Screenshot at /tmp/hl-after.png')

  await page.waitForTimeout(1000)
  await ctx.close()
  await browser.close()
  console.log('Done')
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
