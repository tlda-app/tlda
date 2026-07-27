#!/usr/bin/env node
// Verifies the typed-row inbox: time-sort interleaves kinds newest-first, the
// sort toggle flips to grouped-by-type, staleAt/createdAt drive the order, and
// hover-preview + auto-resolve still work. Runs against the isolated rig.
import { chromium } from 'playwright'

const VITE = 'https://localhost:5190'
const DOC = 'ribbon-test'
const HEADED = process.argv.includes('--headed')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const log = (...a) => console.log(...a)

const browser = await chromium.launch({ headless: !HEADED })
const ctx = await browser.newContext({ viewport: { width: 3840, height: 1400 }, ignoreHTTPSErrors: true })
const page = await ctx.newPage()
page.on('pageerror', e => console.error('  [pageerror]', e.message))

await page.addInitScript(() => {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('fleet-') || k.startsWith('tldraw') || k.startsWith('TLDRAW')) localStorage.removeItem(k) } catch {}
  try { sessionStorage.clear() } catch {}
  try { localStorage.setItem('fleet-hud-expanded', '1') } catch {}
  try { localStorage.setItem('tlda-identity', 'tester') } catch {}
})

await page.goto(`${VITE}/?project=${DOC}&name=tester&pw=1`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__tldraw_editor__, null, { timeout: 30000 })
await page.waitForFunction(() => window.__tldraw_editor__.getCurrentPageShapes().some(s => s.type === 'svg-page'), null, { timeout: 30000 })
log('✓ editor + pages')

await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const PAGE = new Set(['svg-page', 'html-page', 'doc-version', 'toc-drop-target'])
  const rm = ed.getCurrentPageShapes().filter(s => !PAGE.has(s.type)).map(s => s.id)
  if (rm.length) ed.store.remove(rm)
})

const pill = await page.$('.fleet-icon-pill-container')
const box = await pill.boundingBox()
const sx = box.x + box.width / 2, sy = box.y + box.height / 2
await page.mouse.move(sx, sy); await page.mouse.down()
await page.mouse.move(sx + 12, sy, { steps: 5 }); await page.mouse.move(sx + 24, sy, { steps: 5 })
await page.waitForTimeout(150); await page.mouse.up()
await page.waitForFunction(() => window.__tldraw_editor__.getCurrentPageShapes().filter(s => s.type === 'fleet-inbox').length >= 1, null, { timeout: 10000 })
log('✓ layout')

// Inject interleaved times: note(5000) > task(4000) > note(3000) > task(2000).
// time-sort must alternate note/task/note/task; type-sort groups them.
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const pages = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page')
  const b = ed.getShapePageBounds(pages[0].id)
  const top = Math.min(...pages.map(s => ed.getShapePageBounds(s.id).y))
  const bot = Math.max(...pages.map(s => ed.getShapePageBounds(s.id).maxY))
  // ribbon with two stale approved spans carrying staleAt
  if (!ed.getShape('shape:understanding-ribbon'))
    ed.createShape({ id: 'shape:understanding-ribbon', type: 'understanding-line', x: 0, y: top, isLocked: true, props: { w: 6, h: bot - top, segments: '[]' } })
  ed.store.update('shape:understanding-ribbon', s => ({ ...s, props: { ...s.props, segments: JSON.stringify([
    { startLine: 98, endLine: 102, startFile: '', endFile: '', status: 'approved', y1: 200, y2: 260, approvedAtCommit: 'c', stale: true, staleAt: 4000 },
    { startLine: 298, endLine: 302, startFile: '', endFile: '', status: 'approved', y1: 600, y2: 660, approvedAtCommit: 'c', stale: true, staleAt: 2000 },
  ]) } }))
  // two notes carrying createdAt
  ed.createShape({ id: 'shape:nA', type: 'math-note', x: b.x + 40, y: b.y + 120, props: { w: 200, h: 70, text: 'newest note', color: 'blue', autoSize: false }, meta: { sourceAnchor: { file: 'body.tex', line: 10 }, createdAt: 5000 } })
  ed.createShape({ id: 'shape:nB', type: 'math-note', x: b.x + 40, y: b.y + 240, props: { w: 200, h: 70, text: 'middle note', color: 'violet', autoSize: false }, meta: { sourceAnchor: { file: 'body.tex', line: 20 }, createdAt: 3000 } })
})
await page.waitForTimeout(500)

await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const inbox = ed.getCurrentPageShapes().find(s => s.type === 'fleet-inbox')
  const bb = ed.getShapePageBounds(inbox.id)
  if (bb) ed.zoomToBounds(bb, { inset: 60, animation: { duration: 0 } })
})
await page.waitForTimeout(700)

const kindOf = (cls) => cls.includes('fleet-inbox-task') ? 'task' : cls.includes('fleet-inbox-note') ? 'note' : cls.includes('fleet-inbox-thread') ? 'msg' : '?'

// VERIFY 1: default = time → interleaved newest-first: note, task, note, task.
const sortDefault = await page.evaluate(() => document.querySelector('.fleet-inbox-sort-btn.active')?.textContent)
const order1 = await page.evaluate((kindSrc) => {
  const kindOf = eval(kindSrc)
  return [...document.querySelectorAll('.fleet-inbox-list > .fleet-inbox-task, .fleet-inbox-list > .fleet-inbox-note, .fleet-inbox-list > .fleet-inbox-thread')].map(e => kindOf(e.className))
}, kindOf.toString())
log('VERIFY 1 (default sort + interleaved order):', JSON.stringify({ sortDefault, order1 }))
await page.screenshot({ path: 'inbox-typed-time.png', clip: { x: 0, y: 0, width: 760, height: 760 } })

// VERIFY 2: switch to type → grouped sections present, no interleaving at list root.
await page.click('.fleet-inbox-sort-btn:has-text("type")')
await page.waitForTimeout(300)
const grouped = await page.evaluate(() => ({
  groups: [...document.querySelectorAll('.fleet-inbox-group-label')].map(e => e.textContent),
  active: document.querySelector('.fleet-inbox-sort-btn.active')?.textContent,
  tasksInGroup: document.querySelectorAll('.fleet-inbox-tasks .fleet-inbox-task').length,
  notesInGroup: document.querySelectorAll('.fleet-inbox-notes .fleet-inbox-note').length,
}))
log('VERIFY 2 (grouped by type):', JSON.stringify(grouped))

// VERIFY 3: hover a task still previews in annotation viewer w/o moving the doc.
await page.click('.fleet-inbox-sort-btn:has-text("time")')
await page.waitForTimeout(200)
const camB = await page.evaluate(() => { const c = window.__tldraw_editor__.getCamera(); return { x: c.x, y: c.y } })
await page.hover('.fleet-inbox-task')
await page.waitForTimeout(500)
const viewerShown = await page.evaluate(() => !!document.querySelector('.annotation-viewer'))
const camA = await page.evaluate(() => { const c = window.__tldraw_editor__.getCamera(); return { x: c.x, y: c.y } })
const docMoved = Math.abs(camB.x - camA.x) > 1 || Math.abs(camB.y - camA.y) > 1
log('VERIFY 3 (hover preview, doc still):', JSON.stringify({ viewerShown, docMoved }))

// VERIFY 4: address a note → drops out of the stream.
await page.evaluate(() => { window.__tldraw_editor__.store.update('shape:nA', s => ({ ...s, meta: { ...s.meta, addressed: true } })) })
await page.waitForTimeout(400)
const afterAddress = await page.evaluate(() => document.querySelectorAll('.fleet-inbox-note').length)
log('VERIFY 4 (note auto-resolves):', JSON.stringify({ remainingNotes: afterAddress }))

const interleavedOK = JSON.stringify(order1) === JSON.stringify(['note', 'task', 'note', 'task'])
const groupedOK = grouped.groups.includes('Tasks') && grouped.groups.includes('Notes') && grouped.tasksInGroup === 2 && grouped.notesInGroup === 2
const pass = sortDefault === 'time' && interleavedOK && groupedOK && viewerShown && !docMoved && afterAddress === 1
log(pass ? '\n✅ ALL CHECKS PASSED' : '\n❌ SOME CHECK FAILED')
if (!process.argv.includes('--keep-open')) await browser.close()
process.exit(pass ? 0 : 1)
