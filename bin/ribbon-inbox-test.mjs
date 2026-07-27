#!/usr/bin/env node
// Verifies the ribbon-revalidation → inbox-task loop end to end against the dev
// server (5280), served through the dev vite (5179) so it picks up the
// uncommitted FleetInboxShape change. Own chromium (shared pw is flaky).
import { chromium } from 'playwright'

const VITE = 'https://localhost:5179'
const DOC = 'ribbon-test'
const HEADED = process.argv.includes('--headed')
const A = '9b427d84e3b8414dc6a3d942d7402ff086e94711'
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

await page.goto(`${VITE}/?project=${DOC}&name=tester&pw=1`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__tldraw_editor__, null, { timeout: 30000 })
await page.waitForFunction(() => window.__tldraw_editor__.getCurrentPageShapes().some(s => s.type === 'svg-page'), null, { timeout: 30000 })
log('✓ editor mounted + pages loaded')

// Clean slate: remove non-page shapes.
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const PAGE = new Set(['svg-page', 'html-page', 'doc-version', 'toc-drop-target'])
  const rm = ed.getCurrentPageShapes().filter(s => !PAGE.has(s.type)).map(s => s.id)
  if (rm.length) ed.store.remove(rm)
})
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const pages = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page')
  if (pages.length) { const b = ed.getShapePageBounds(pages[0].id); if (b) ed.zoomToBounds(b, { inset: 16, animation: { duration: 0 } }) }
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
const counts = await page.evaluate(() => { const ed = window.__tldraw_editor__; const t = {}; for (const s of ed.getCurrentPageShapes()) t[s.type] = (t[s.type]||0)+1; return t })
log('✓ fleet layout:', JSON.stringify(counts))

// Ensure ribbon exists + inject ONE stale approved span (98-102) + a fresh control (298-302).
await page.evaluate((A) => {
  const ed = window.__tldraw_editor__
  const sent = ed.store.get('shape:doc-version--sentinel')
  if (sent) ed.store.update('shape:doc-version--sentinel', s => ({ ...s, props: { ...s.props, commitHash: A } }))
  let r = ed.getShape('shape:understanding-ribbon')
  if (!r) {
    const pages = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page')
    const top = Math.min(...pages.map(s => ed.getShapePageBounds(s.id).y))
    const bot = Math.max(...pages.map(s => ed.getShapePageBounds(s.id).maxY))
    ed.createShape({ id: 'shape:understanding-ribbon', type: 'understanding-line', x: 0, y: top, isLocked: true, props: { w: 6, h: bot - top, segments: '[]' } })
    r = ed.getShape('shape:understanding-ribbon')
  }
  const segs = [
    { startLine: 98, endLine: 102, startFile: '', endFile: '', status: 'approved', y1: 200, y2: 260, approvedAtCommit: A, stale: true },
    { startLine: 298, endLine: 302, startFile: '', endFile: '', status: 'approved', y1: 600, y2: 660, approvedAtCommit: A, stale: false },
  ]
  ed.store.update('shape:understanding-ribbon', s => ({ ...s, props: { ...s.props, segments: JSON.stringify(segs) } }))
}, A)
await page.waitForTimeout(400)

// Frame directly on the INBOX shape's own canvas bounds — useIsInViewport keys
// off the shape's canvas bounds, so this guarantees it's in viewport and paints.
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const inbox = ed.getCurrentPageShapes().find(s => s.type === 'fleet-inbox')
  if (!inbox) return
  const b = ed.getShapePageBounds(inbox.id)
  if (b) ed.zoomToBounds(b, { inset: 60, animation: { duration: 0 } })
})
await page.waitForTimeout(800)

// DIAGNOSTICS
const diag = await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const inbox = ed.getCurrentPageShapes().find(s => s.type === 'fleet-inbox')
  const r = ed.getShape('shape:understanding-ribbon')
  let segs = []
  try { segs = r ? JSON.parse(r.props.segments) : [] } catch {}
  const owners = {}
  for (const s of ed.getCurrentPageShapes()) if (String(s.type).startsWith('fleet-')) owners[s.type] = s.props?.userId
  return {
    hudWrap: !!document.querySelector('.fleet-hud-wrap'),
    panels: {
      inbox: !!document.querySelector('.fleet-inbox-shape'),
      chat: !!document.querySelector('.fleet-chat-shape'),
      agents: !!document.querySelector('.fleet-agents-shape, .fleet-agents'),
      search: !!document.querySelector('.fleet-search-shape, .fleet-search'),
    },
    identity: localStorage.getItem('tlda-identity'),
    owners,
    ribbonExists: !!r,
    segCount: segs.length,
    staleApproved: segs.filter(s => s.stale && s.status === 'approved').length,
    sampleSeg: segs[0] || null,
    inboxHTML: (document.querySelector('.fleet-inbox-shape')?.innerHTML || '').replace(/\s+/g, ' ').slice(0, 500),
  }
})
log('DIAG:', JSON.stringify(diag))

// REACTIVITY PROBE: now that the inbox is confirmed mounted, force a fresh
// ribbon update and see if the task appears (distinguishes timing from logic).
await page.evaluate((A) => {
  const ed = window.__tldraw_editor__
  const r = ed.getShape('shape:understanding-ribbon')
  const segs = JSON.parse(r.props.segments)
  segs[0].y2 = 261 // tiny change to force a store update
  ed.store.update('shape:understanding-ribbon', s => ({ ...s, props: { ...s.props, segments: JSON.stringify(segs) } }))
}, A)
await page.waitForTimeout(600)
const probe = await page.evaluate(() => ({
  group: !!document.querySelector('.fleet-inbox-group-label'),
  tasks: [...document.querySelectorAll('.fleet-inbox-task-text')].map(e => e.textContent),
}))
log('REACTIVITY PROBE (after forced update):', JSON.stringify(probe))

// VERIFY 1: inbox shows the Tasks group with exactly one revalidation card.
const v1 = await page.evaluate(() => {
  const tasks = [...document.querySelectorAll('.fleet-inbox-task-text')].map(e => e.textContent)
  const sub = [...document.querySelectorAll('.fleet-inbox-task-sub')].map(e => e.textContent)
  const total = document.querySelector('.fleet-inbox-task-total')?.textContent || null
  const hasGroup = !!document.querySelector('.fleet-inbox-group-label')
  return { hasGroup, tasks, sub, total }
})
log('VERIFY 1 (task appears):', JSON.stringify(v1))
await page.screenshot({ path: 'ribbon-inbox-1-task.png', clip: { x: 0, y: 0, width: 700, height: 700 } })

// VERIFY 2: hover the task → annotation viewer appears AND the main doc does NOT move.
const camBefore = await page.evaluate(() => { const c = window.__tldraw_editor__.getCamera(); return { x: c.x, y: c.y, z: c.z } })
const hasCard = await page.$('.fleet-inbox-task')
if (!hasCard) { log('  (no task card — skipping hover/resolve checks)'); await page.screenshot({ path: 'ribbon-inbox-1-task.png' }); await browser.close(); process.exit(1) }
await page.hover('.fleet-inbox-task')
await page.waitForTimeout(600)
const viewerShown = await page.evaluate(() => !!document.querySelector('.annotation-viewer'))
const camAfter = await page.evaluate(() => { const c = window.__tldraw_editor__.getCamera(); return { x: c.x, y: c.y, z: c.z } })
const docMoved = Math.abs(camBefore.y - camAfter.y) > 1 || Math.abs(camBefore.x - camAfter.x) > 1
await page.screenshot({ path: 'ribbon-inbox-3-hover.png', clip: { x: 0, y: 0, width: 1100, height: 900 } })
log('VERIFY 2 (hover previews, doc stays put):', JSON.stringify({ viewerShown, docMoved }))

// VERIFY 3: re-approve the stale span → its task auto-resolves (card vanishes).
await page.evaluate((A) => {
  const ed = window.__tldraw_editor__
  // simulate re-approval: the stale span is replaced by a fresh approved span
  // anchored at the CURRENT commit (no longer stale).
  const cur = ed.store.get('shape:doc-version--sentinel')?.props?.commitHash || A
  const segs = [
    { startLine: 98, endLine: 102, startFile: '', endFile: '', status: 'approved', y1: 200, y2: 260, approvedAtCommit: cur, stale: false },
    { startLine: 298, endLine: 302, startFile: '', endFile: '', status: 'approved', y1: 600, y2: 660, approvedAtCommit: A, stale: false },
  ]
  ed.store.update('shape:understanding-ribbon', s => ({ ...s, props: { ...s.props, segments: JSON.stringify(segs) } }))
}, A)
await page.waitForTimeout(500)
const v3 = await page.evaluate(() => ({
  taskCount: document.querySelectorAll('.fleet-inbox-task').length,
  total: document.querySelector('.fleet-inbox-task-total')?.textContent || null,
}))
log('VERIFY 3 (auto-resolve on re-approve):', JSON.stringify(v3))
await page.screenshot({ path: 'ribbon-inbox-2-resolved.png' })

const pass = v1.hasGroup && v1.tasks.length === 1 && v1.tasks[0].includes('98') && viewerShown && !docMoved && v3.taskCount === 0
log(pass ? '\n✅ ALL CHECKS PASSED' : '\n❌ SOME CHECK FAILED')

if (!process.argv.includes('--keep-open')) await browser.close()
process.exit(pass ? 0 : 1)
