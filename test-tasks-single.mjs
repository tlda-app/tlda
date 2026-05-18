import { chromium } from 'playwright'
const TOKEN = process.env.TOKEN
const BASE = 'http://localhost:5174'
const OUT = '/Users/skip/work/tlda/scratch'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 500, height: 580 } })
await page.goto(`${BASE}/?doc=bregman&token=${TOKEN}`)
await page.waitForFunction(() => document.querySelector('.tl-canvas') !== null, { timeout: 35000 })
await page.waitForTimeout(5000)
// Delete any pre-existing fleet-tasks shapes first
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const existing = ed.getCurrentPageShapes().filter(s => s.type === 'fleet-tasks')
  if (existing.length) ed.run(() => ed.deleteShapes(existing.map(s => s.id)), { history: 'ignore' })
})
await page.waitForTimeout(500)
const shapeId = `shape:single-${Date.now()}`
await page.evaluate((id) => {
  const ed = window.__tldraw_editor__
  ed.run(() => { ed.createShape({ id, type: 'fleet-tasks', x: 0, y: 50000, props: { w: 340, h: 500 } }) }, { history: 'ignore' })
  const b = ed.getShapePageBounds(id)
  if (b) ed.zoomToBounds(b, { animation: { duration: 0 }, inset: 20 })
}, shapeId)
await page.waitForTimeout(2000)
// Done tab
const tabs = await page.$$('.fleet-tasks-tab')
const doneTab = (await Promise.all(tabs.map(async t => ({ t, txt: await t.textContent() })))).find(x => x.txt.trim().startsWith('done'))
if (doneTab) await page.evaluate(el => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), doneTab.t)
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/ts-single-done.png` })
console.log('ts-single-done.png — done tab, 0 tasks')
// Active tab
const activeTab = (await Promise.all(tabs.map(async t => ({ t, txt: await t.textContent() })))).find(x => x.txt.trim().startsWith('active'))
if (activeTab) await page.evaluate(el => el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), activeTab.t)
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/ts-single-active.png` })
console.log('ts-single-active.png — active tab')
await browser.close()
