import { chromium } from 'playwright'

const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 500, height: 580 } })

const apiErrors = []
page.on('console', m => {
  const txt = m.text()
  if (m.type() === 'error' && !txt.includes('9876') && !txt.includes('sync error'))
    apiErrors.push(txt.slice(0, 100))
})

await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(5000)  // wait 5s for fleet data to load

const shapeId = `shape:fleet-tasks-vp2-${Date.now()}`
await page.evaluate((id) => {
  const ed = window.__tldraw_editor__
  ed.run(() => {
    ed.createShape({
      id,
      type: 'fleet-tasks',
      x: 0, y: 50000,
      props: { w: 340, h: 500 },
    })
  }, { history: 'ignore' })
  const bounds = ed.getShapePageBounds(id)
  if (bounds) ed.zoomToBounds(bounds, { animation: { duration: 0 }, inset: 20 })
}, shapeId)

await page.waitForTimeout(3000)  // wait for tasks to load

const taskCount = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.fleet-tasks-tab')]
  return tabs.map(t => t.textContent.trim())
})
console.log('Tabs:', taskCount)

// Sample rows
const sample = await page.evaluate(() => {
  return [...document.querySelectorAll('.fleet-tasks-row')].slice(0, 3).map(r => ({
    agent: r.querySelector('.fleet-tasks-agent-pill')?.textContent?.trim(),
    desc: r.querySelector('.fleet-tasks-desc')?.textContent?.trim(),
    status: r.querySelector('.fleet-tasks-status-badge')?.textContent?.trim(),
  }))
})
console.log('Sample:', sample)

await page.screenshot({ path: `${OUT}/ts-vp2-active.png` })
console.log('ts-vp2-active.png')

if (apiErrors.length) console.log('API errors:', apiErrors)

await browser.close()
