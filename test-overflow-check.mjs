import { chromium } from 'playwright'
const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(4000)

// Open overflow
const moreBtn = await page.$('[data-testid="tools.more-button"]')
if (!moreBtn) { console.log('no more-button'); await browser.close(); process.exit(1) }
await page.evaluate(el => el.click(), moreBtn)
await page.waitForTimeout(600)

// List all tools
const allTools = await page.$$eval('[data-testid^="tools."]', els => els.map(e => e.dataset.testid))
console.log('All tools after overflow open:', allTools.join(', '))

await browser.close()
