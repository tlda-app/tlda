#!/usr/bin/env node
// Structural-invalidation inbox test. Seeds ONE stale approved ribbon span over
// Prop 8.2's statement (prop:matching-cost, lines 1683–1686 in balancing-act) and
// verifies the proof-dependency cascade surfaces as inbox tasks:
//   - directly-stale node  : "Proposition 8.2" (own statement changed) + approve
//   - cascade-stale node   : "Proposition 8.3" (prop:matching-achievable),
//                            shown as "depends on Proposition 8.2"
// Then clicks approve on the direct node and verifies BOTH clear
// (approve-upstream-clears-downstream). Runs against the isolated rig.
import { chromium } from 'playwright'

const VITE = 'https://localhost:5191'
const DOC = 'balancing-act'
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
  try { localStorage.setItem('fleet-inbox-sort', 'type') } catch {}
})

await page.goto(`${VITE}/?doc=${DOC}&name=tester&pw=1`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__tldraw_editor__, null, { timeout: 30000 })
await page.waitForFunction(() => window.__tldraw_editor__.getCurrentPageShapes().some(s => s.type === 'svg-page'), null, { timeout: 30000 })
log('✓ editor + pages')

await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const PAGE = new Set(['svg-page', 'html-page', 'doc-version', 'toc-drop-target'])
  const rm = ed.getCurrentPageShapes().filter(s => !PAGE.has(s.type)).map(s => s.id)
  if (rm.length) ed.store.remove(rm)
})

// Open the fleet layout (inbox panel) via the pill drag.
const pill = await page.$('.fleet-icon-pill-container')
const box = await pill.boundingBox()
const sx = box.x + box.width / 2, sy = box.y + box.height / 2
await page.mouse.move(sx, sy); await page.mouse.down()
await page.mouse.move(sx + 12, sy, { steps: 5 }); await page.mouse.move(sx + 24, sy, { steps: 5 })
await page.waitForTimeout(150); await page.mouse.up()
await page.waitForFunction(() => window.__tldraw_editor__.getCurrentPageShapes().filter(s => s.type === 'fleet-inbox').length >= 1, null, { timeout: 10000 })
log('✓ layout')



// Seed: a doc-version sentinel (so approve has a commit to anchor to) and a
// ribbon with ONE stale, approved span over Prop 8.2's statement (1683–1686).
await page.evaluate(() => {
  const ed = window.__tldraw_editor__
  const pages = ed.getCurrentPageShapes().filter(s => s.type === 'svg-page')
  const top = Math.min(...pages.map(s => ed.getShapePageBounds(s.id).y))
  const bot = Math.max(...pages.map(s => ed.getShapePageBounds(s.id).maxY))
  if (!ed.getShape('shape:doc-version--sentinel'))
    ed.createShape({ id: 'shape:doc-version--sentinel', type: 'doc-version', x: 0, y: top, isLocked: true, props: { commitHash: 'cur-commit', buildReadyAt: 5000 } })
  if (!ed.getShape('shape:understanding-ribbon'))
    ed.createShape({ id: 'shape:understanding-ribbon', type: 'understanding-line', x: 0, y: top, isLocked: true, props: { w: 6, h: bot - top, segments: '[]' } })
  ed.store.update('shape:understanding-ribbon', s => ({ ...s, props: { ...s.props, segments: JSON.stringify([
    // Prop 8.2 (prop:matching-cost) — feeds the cascade to Prop 8.3.
    { startLine: 1683, endLine: 1686, startFile: '', endFile: '', status: 'approved', y1: 200, y2: 260, approvedAtCommit: 'old-commit', stale: true, staleAt: 4000 },
    // Prop 7.1 (proposition:clt-general) — independent; no cascade, no dependents.
    // Stays after we approve Prop 8.2, proving the clear is scoped to one chain.
    { startLine: 1551, endLine: 1565, startFile: '', endFile: '', status: 'approved', y1: 80, y2: 130, approvedAtCommit: 'old-commit', stale: true, staleAt: 3000 },
  ]) } }))
})
await page.waitForTimeout(700)

const readRows = () => page.evaluate(() => ({
  groups: [...document.querySelectorAll('.fleet-inbox-group-label')].map(e => e.textContent),
  direct: [...document.querySelectorAll('.fleet-inbox-node-direct')].map(e => ({
    title: e.querySelector('.fleet-inbox-node-title')?.textContent,
    sub: e.querySelector('.fleet-inbox-node-sub')?.textContent,
    hasApprove: !!e.querySelector('.fleet-inbox-node-approve'),
  })),
  cascade: [...document.querySelectorAll('.fleet-inbox-node-cascade')].map(e => ({
    title: e.querySelector('.fleet-inbox-node-title')?.textContent,
    sub: e.querySelector('.fleet-inbox-node-sub')?.textContent,
  })),
  badge: document.querySelector('.fleet-inbox-task-total')?.textContent,
}))

const before = await readRows()
log('VERIFY 1 (cascade surfaces):', JSON.stringify(before, null, 1))
// The inbox is the leftmost HUD panel and pins partly off the left edge at this
// doc's camera (panels are fixed-position, camera-compensated in the HUD editor;
// a layout recompute resets the compensation). So shift the HUD editor camera
// right immediately before each capture. Verified lever (probe-hud). Cosmetic
// only — the panel is interactive where it sits regardless.
const shot = async (name) => {
  // Shift the HUD camera until the panel's left edge is on-screen, then capture
  // by its computed rect (el.screenshot is flaky on a partially-offscreen panel).
  // The approve action triggers a HUD re-layout that resets the camera, so poll
  // until the position is STABLE on-screen across two consecutive reads.
  let rect = null, stable = 0
  for (let i = 0; i < 12 && stable < 2; i++) {
    rect = await page.evaluate(() => {
      const e = window.__tldraw_hud_editor__
      const r = document.querySelector('.fleet-inbox-shape')?.getBoundingClientRect()
      if (e && r && r.left < 12) { const cam = e.getCamera(); e.setCamera({ x: cam.x + (12 - r.left) + 20, y: cam.y, z: cam.z }) }
      const r2 = document.querySelector('.fleet-inbox-shape')?.getBoundingClientRect()
      return r2 ? { left: r2.left, top: r2.top, width: r2.width, height: r2.height } : null
    })
    await page.waitForTimeout(160)
    stable = (rect && rect.left >= 8) ? stable + 1 : 0
  }
  if (rect && rect.left >= 0) {
    await page.screenshot({ path: name, clip: { x: Math.max(0, rect.left - 2), y: Math.max(0, rect.top - 2), width: Math.min(rect.width + 4, 900), height: Math.min(rect.height + 4, 1380) } })
  } else {
    await page.screenshot({ path: name, clip: { x: 0, y: 0, width: 820, height: 820 } })
  }
}
await shot('inbox-structural-before.png')

// VERIFY 2: approve ONLY Prop 8.2 → it and its cascade (Prop 8.3) clear, while the
// independent Prop 7.1 task remains (the clear is scoped to one dependency chain).
await page.locator('.fleet-inbox-node-direct', { hasText: 'Proposition 8.2' }).locator('.fleet-inbox-node-approve').click()
await page.waitForTimeout(1000)
const after = await readRows()
log('VERIFY 2 (approve-upstream-clears-downstream):', JSON.stringify(after, null, 1))
const seg = await page.evaluate(() => {
  try {
    const segs = JSON.parse(window.__tldraw_editor__.getShape('shape:understanding-ribbon').props.segments)
    return segs.find((s) => Math.min(s.startLine, s.endLine) === 1683) || null
  } catch { return null }
})
log('   matching-cost span after approve:', JSON.stringify(seg))
await shot('inbox-structural-after.png')

const titles = (arr) => arr.map((x) => x.title).sort()
const directOK = before.direct.length === 2
  && JSON.stringify(titles(before.direct)) === JSON.stringify(['Proposition 7.1', 'Proposition 8.2'])
  && before.direct.every((d) => d.hasApprove)
  && before.direct.some((d) => /lines 1683.1686/.test(d.sub || ''))
const cascadeOK = before.cascade.length === 1
  && before.cascade[0].title === 'Proposition 8.3'
  && /Proposition 8\.2/.test(before.cascade[0].sub || '')
const groupsOK = before.groups.includes('Tasks') && before.groups.includes('Cascade')
// Approve-upstream-clears-downstream, scoped: Prop 8.2 + its cascade Prop 8.3
// gone; the independent Prop 7.1 survives.
const clearedOK = after.cascade.length === 0
  && after.direct.length === 1
  && after.direct[0].title === 'Proposition 7.1'
// Re-vetted: stale cleared, staleAt cleared, re-anchored to a commit that is no
// longer the old one (the viewer's live sentinel supplies the real current hash).
const segOK = seg && seg.stale === false && seg.staleAt == null
  && !!seg.approvedAtCommit && seg.approvedAtCommit !== 'old-commit'

const pass = directOK && cascadeOK && groupsOK && clearedOK && segOK
log('\nchecks:', JSON.stringify({ directOK, cascadeOK, groupsOK, clearedOK, segOK }))
log(pass ? '\n✅ ALL CHECKS PASSED' : '\n❌ SOME CHECK FAILED')
if (!process.argv.includes('--keep-open')) await browser.close()
process.exit(pass ? 0 : 1)
