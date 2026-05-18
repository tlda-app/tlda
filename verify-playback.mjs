import { chromium } from 'playwright'

const URL = 'file:///tmp/pbf-render.html'
const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext({ viewport: { width: 900, height: 400 } })
const page = await ctx.newPage()

await page.goto(URL, { waitUntil: 'load', timeout: 10000 })
await page.waitForTimeout(1000)
await page.screenshot({ path: '/tmp/pbf-visual.png', fullPage: true })
console.log('screenshot taken')
await browser.close()
