#!/usr/bin/env node
// Verifies the doc-notes → inbox "Notes" group loop end to end against the dev
// server (5280), served through the dev vite (5179) so it picks up the
// uncommitted FleetInboxShape change. Own chromium (shared pw is flaky).
//
// Checks: (1) an unaddressed math-note surfaces as a Notes-group card,
// (2) hover previews it in the annotation viewer WITHOUT moving the main doc,
// (3) marking the note meta.addressed=true auto-resolves the card.
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
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()) })

await page.addInitScript(() => {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('fleet-') || k.startsWith('tldraw') || k.startsWith('TLDRAW')) localStorage.removeItem(k) } catch {}
  try { sessionStorage.clear() } catch {}
  try { localStorage.setItem('fleet-hud-expanded', '1') } catch {}
  try { localStorage.setItem('tlda-identity', 'tester') } catch {}
})

await page.goto(`${VITE}/?doc=${DOC}&name=tester&pw=1`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__tldraw_editor__, null, { timeout: 30000 })
await page.waitForFunction(() => window.__tldraw_editor__.getCurrentPageShapes().some(s => s.type === 'svg-page'), null, { timeout: 30000 })
log('✓ editor mounted + pages loaded')

// Clean slate: remove non-page shapes (notes, ribbons, fleet panels from prior runs).
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const PAGE = new Set(['svg-page', 'html-page', 'doc-version', 'toc-drop-target'])
  const rm = ed.getCurrentPageShapes().filter(s => !PAGE.has(s.type)).map(s => s.id)
  if (rm.length) ed.store.remove(rm)
})

// Build the 3-col fleet layout (incl fleet-inbox) via the pill drag.
const pill = await page.$('.fleet-icon-pill-container')
if (!pill) throw new Error('no fleet icon pill')
const box = await pill.boundingBox()
const sx = box.x + box.width / 2, sy = box.y + box.height / 2
await page.mouse.move(sx, sy); await page.mouse.down()
await page.mouse.move(sx + 10, sy, { steps: 5 }); await page.mouse.move(sx + 22, sy, { steps: 5 })
await page.waitForTimeout(150); await page.mouse.up()
await page.waitForFunction(() => window.__tldraw_editor__.getCurrentPageShapes().filter(s => ['fleet-chat','fleet-agents','fleet-search','fleet-docview','fleet-inbox'].includes(s.type)).length >= 5, null, { timeout: 10000 })
log('✓ fleet layout up')

// Inject TWO notes: one OPEN (unaddressed) + one ALREADY ADDRESSED (control,
// must NOT appear). Anchor them on the first page so getShapePageBounds works.
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const pages = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page')
  const b = ed.getShapePageBounds(pages[0].id)
  ed.createShape({
    id: 'shape:note-open', type: 'math-note',
    x: b.x + 40, y: b.y + 120,
    props: { w: 220, h: 80, text: 'Is this bound tight? $\\epsilon < 1$', color: 'blue', autoSize: false },
    meta: { sourceAnchor: { file: 'body.tex', line: 142 } },
  })
  ed.createShape({
    id: 'shape:note-done', type: 'math-note',
    x: b.x + 40, y: b.y + 320,
    props: { w: 220, h: 80, text: 'Already answered note', color: 'green', autoSize: false },
    meta: { sourceAnchor: { file: 'body.tex', line: 200 }, addressed: true },
  })
})
await page.waitForTimeout(400)

// Frame on the INBOX shape's own canvas bounds so it's in viewport and paints.
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const inbox = ed.getCurrentPageShapes().find(s => s.type === 'fleet-inbox')
  const bb = ed.getShapePageBounds(inbox.id)
  if (bb) ed.zoomToBounds(bb, { inset: 60, animation: { duration: 0 } })
})
await page.waitForTimeout(800)

// VERIFY 1: Notes group shows exactly the OPEN note (addressed one excluded).
const v1 = await page.evaluate(() => ({
  hasGroup: [...document.querySelectorAll('.fleet-inbox-group-label')].some(e => e.textContent === 'Notes'),
  notes: [...document.querySelectorAll('.fleet-inbox-note-text')].map(e => e.textContent),
  sub: [...document.querySelectorAll('.fleet-inbox-note-sub')].map(e => e.textContent),
  total: document.querySelector('.fleet-inbox-note-total')?.textContent || null,
}))
log('VERIFY 1 (open note appears, addressed excluded):', JSON.stringify(v1))
await page.screenshot({ path: 'inbox-notes-1.png', clip: { x: 0, y: 0, width: 760, height: 760 } })

// VERIFY 2: hover the note → annotation viewer appears AND main doc does NOT move.
const camBefore = await page.evaluate(() => { const c = window.__tldraw_editor__.getCamera(); return { x: c.x, y: c.y, z: c.z } })
const card = await page.$('.fleet-inbox-note')
if (!card) { log('  (no note card — failing)'); await browser.close(); process.exit(1) }
await page.hover('.fleet-inbox-note')
await page.waitForTimeout(600)
const viewerShown = await page.evaluate(() => !!document.querySelector('.annotation-viewer'))
const camAfter = await page.evaluate(() => { const c = window.__tldraw_editor__.getCamera(); return { x: c.x, y: c.y, z: c.z } })
const docMoved = Math.abs(camBefore.y - camAfter.y) > 1 || Math.abs(camBefore.x - camAfter.x) > 1
await page.screenshot({ path: 'inbox-notes-2-hover.png', clip: { x: 0, y: 0, width: 1200, height: 900 } })
log('VERIFY 2 (hover previews, doc stays put):', JSON.stringify({ viewerShown, docMoved }))

// VERIFY 3: mark the open note addressed → its card auto-resolves (vanishes).
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  ed.store.update('shape:note-open', s => ({ ...s, meta: { ...s.meta, addressed: true } }))
})
await page.waitForTimeout(500)
const v3 = await page.evaluate(() => ({
  noteCount: document.querySelectorAll('.fleet-inbox-note').length,
  total: document.querySelector('.fleet-inbox-note-total')?.textContent || null,
}))
log('VERIFY 3 (auto-resolve on addressed):', JSON.stringify(v3))
await page.screenshot({ path: 'inbox-notes-3-resolved.png', clip: { x: 0, y: 0, width: 760, height: 760 } })

const pass = v1.hasGroup && v1.notes.length === 1 && v1.notes[0].includes('bound') && viewerShown && !docMoved && v3.noteCount === 0
log(pass ? '\n✅ ALL CHECKS PASSED' : '\n❌ SOME CHECK FAILED')

if (!process.argv.includes('--keep-open')) await browser.close()
process.exit(pass ? 0 : 1)
