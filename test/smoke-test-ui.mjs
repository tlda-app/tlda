#!/usr/bin/env node
/**
 * smoke-test-ui.mjs — basic playwright smoke test for FleetHUD + chat.
 *
 * Run after every UI change to catch regressions in routine interactions.
 * Tests, in order:
 *   1. Page loads (bregman doc) without console errors blocking init
 *   2. Fleet HUD wrap is present in the DOM
 *   3. At least one fleet-chat-log is present
 *   4. Chat-log has no nested scrollable elements (the "scroll within scroll" bug)
 *   5. Real wheel scroll on the chat-log moves scrollTop (the chat scrolls)
 *   6. Layout-mode toggle round-trip preserves HUD position
 *   7. Sending Esc in an empty chat input doesn't throw
 *
 * Each test prints PASS/FAIL with the relevant numbers. Exit code 1 if
 * any failed.
 *
 * Usage: node test/smoke-test-ui.mjs [--doc=DOC] [--url=BASE] [--rig=rig.json]
 */

import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { hasTls } from '../shared/config.mjs'
import { resolveRigEnv } from './rig-env.mjs'

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=')
      return [k, v.join('=') || true]
    })
)
const rigEnv = resolveRigEnv({ rig: args.rig, doc: args.doc })
const DOC = rigEnv.doc
const BASE = (args.url || rigEnv.viewer || `${hasTls ? 'https' : 'http'}://localhost:5176`).replace(/\/+$/, '')

// Pull the rw token from config.json so headless requests pass auth.
let TOKEN = rigEnv.token
if (!TOKEN && !rigEnv.noAuth) {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.config/tlda/config.json'), 'utf8'))
    TOKEN = cfg.tokenRw || cfg.token || ''
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`  [config] unable to read auth token: ${e.message}`)
  }
}
const URL = `${BASE}/?doc=${encodeURIComponent(DOC)}${TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''}`

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log(`  ${tag}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function main() {
  console.log(`smoke-test-ui  doc=${DOC}  url=${URL}${rigEnv.manifestPath ? `  rig=${rigEnv.manifestPath}` : ''}`)
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log(`  [pageerror] ${e.message}`))
  page.on('console', m => {
    if (m.type() === 'error') console.log(`  [console.error] ${m.text().slice(0, 200)}`)
  })
  page.on('requestfailed', r => console.log(`  [requestfailed] ${r.url()} — ${r.failure()?.errorText}`))

  // 1. Page loads
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    step('1. page loads', true, page.url())
  } catch (e) {
    step('1. page loads', false, e.message)
    await browser.close()
    process.exit(1)
  }

  // Wait for fleet HUD wrap to appear (means React mounted + fleet data
  // initialized). Build pipeline can be slow on a cold cache, so allow
  // up to 30s for the markup to show up.
  try {
    await page.waitForSelector('.fleet-hud-wrap, .fleet-pill-container', { timeout: 30000 })
  } catch {
    // Continue to record failure in step 2
  }
  // Ensure HUD is expanded (fresh browser has no localStorage, so HUD
  // defaults to collapsed pill). Click the pill if it's there.
  await page.evaluate(() => {
    localStorage.setItem('fleet-hud-expanded', '1')
    const pill = document.querySelector('.fleet-pill')
    if (pill) pill.click()
  })
  // Set an override so the HUD is on-screen for the test. Without this,
  // the fbRight auto-layout places the HUD wherever the fleet shapes
  // project to, which is often off-screen in a headless viewport.
  await page.evaluate(() => {
    const editor = window.editor || window.__tldraw_editor__
    if (!editor) return
    const cam = editor.getCamera()
    const vp = window.innerWidth
    const override = {
      canvasX: (vp - 750) / cam.z - cam.x,
      screenY: 50,
      screenW: 700,
      screenH: 600,
    }
    localStorage.setItem('fleet-hud-override', JSON.stringify(override))
  })
  // Reload so the override takes effect
  await page.reload({ waitUntil: 'domcontentloaded' })
  // Then wait for at least one chat-log to render — chat is the part
  // that takes longest because it pulls events from the fleet store.
  try {
    await page.waitForSelector('.fleet-chat-log', { timeout: 15000 })
  } catch {
    // Continue to record failure in step 3
  }
  // A small grace period for chat content to load and the layout to settle
  await page.waitForTimeout(1500)

  // 2. Fleet HUD present
  const hudPresent = await page.evaluate(() =>
    !!document.querySelector('.fleet-hud-wrap, .fleet-pill-container'))
  step('2. fleet HUD present', hudPresent)

  // 3. Chat log present
  const chatLogCount = await page.evaluate(() =>
    document.querySelectorAll('.fleet-chat-log').length)
  step('3. chat-log present', chatLogCount > 0, `count=${chatLogCount}`)

  // 4. No nested scrollable elements inside any chat-log (the inner pre /
  //    diff-side bug). Walk all descendants of every chat-log.
  const nestedScrollables = await page.evaluate(() => {
    const logs = document.querySelectorAll('.fleet-chat-log')
    let count = 0
    for (const log of logs) {
      const walk = (el) => {
        const cs = getComputedStyle(el)
        if (['auto', 'scroll'].includes(cs.overflowY)) count++
        for (const c of el.children) walk(c)
      }
      for (const c of log.children) walk(c)
    }
    return count
  })
  step('4. no nested scrollables in chat-log', nestedScrollables === 0,
    `nested=${nestedScrollables}`)

  // 5. Real wheel scroll moves chat-log scrollTop. Find any visible
  //    scrollable chat-log, scroll to bottom, send a real wheel-up,
  //    confirm scrollTop decreased.
  const scrollResult = await (async () => {
    const target = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.fleet-chat-log'))
      const visible = all.filter(l => {
        const r = l.getBoundingClientRect()
        return r.x >= 0 && r.x + r.width <= window.innerWidth
            && r.width > 50 && l.scrollHeight > l.clientHeight
      })
      if (visible.length === 0) return null
      const log = visible[0]
      log.scrollTop = log.scrollHeight
      const r = log.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, before: log.scrollTop }
    })
    if (!target) return { skipped: true, reason: 'no scrollable chat-log visible' }
    await page.mouse.move(target.x, target.y)
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(400)
    const after = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.fleet-chat-log'))
      const visible = all.filter(l => {
        const r = l.getBoundingClientRect()
        return r.x >= 0 && r.x + r.width <= window.innerWidth
            && r.width > 50 && l.scrollHeight > l.clientHeight
      })
      return visible[0]?.scrollTop
    })
    return { before: target.before, after, scrolled: target.before !== after }
  })()
  if (scrollResult.skipped) {
    step('5. wheel scrolls chat-log', false, 'SKIPPED: ' + scrollResult.reason)
  } else {
    step('5. wheel scrolls chat-log', !!scrollResult.scrolled,
      `before=${Math.round(scrollResult.before)} after=${Math.round(scrollResult.after)}`)
  }

  // 6. Layout-mode toggle round-trip preserves HUD position
  const layoutResult = await page.evaluate(() => new Promise(resolve => {
    const wrap0 = document.querySelector('.fleet-hud-wrap')
    if (!wrap0) return resolve({ error: 'no fleet-hud-wrap' })
    const r0 = wrap0.getBoundingClientRect()
    const btn = document.querySelector('.fleet-hud-layout')
    if (!btn) return resolve({ error: 'no layout button' })
    btn.click()
    setTimeout(() => {
      const wrap1 = document.querySelector('.fleet-hud-wrap')
      const inLayout = wrap1?.classList.contains('fleet-hud-layout-mode')
      // Exit layout
      document.querySelector('.fleet-hud-layout')?.click()
      setTimeout(() => {
        const wrap2 = document.querySelector('.fleet-hud-wrap')
        const r2 = wrap2.getBoundingClientRect()
        resolve({
          before: { x: Math.round(r0.x), w: Math.round(r0.width) },
          after: { x: Math.round(r2.x), w: Math.round(r2.width) },
          enteredLayout: !!inLayout,
          exitedLayout: !wrap2?.classList.contains('fleet-hud-layout-mode'),
          stable: Math.abs(r0.x - r2.x) < 10 && Math.abs(r0.width - r2.width) < 10,
        })
      }, 800)
    }, 800)
  }))
  if (layoutResult.error) {
    step('6. layout-mode round-trip preserves position', false, layoutResult.error)
  } else {
    step('6. layout-mode round-trip preserves position',
      layoutResult.enteredLayout && layoutResult.exitedLayout && layoutResult.stable,
      `before=${JSON.stringify(layoutResult.before)} after=${JSON.stringify(layoutResult.after)}`)
  }

  // 7. Esc on empty chat input doesn't throw (regression we hit before)
  const escResult = await page.evaluate(() => {
    const ta = document.querySelector('.fleet-chat-input, textarea[placeholder*="→"]')
    if (!ta) return { error: 'no chat input found' }
    try {
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })
  step('7. Esc on empty chat input does not throw',
    !escResult.error, escResult.error || '')

  await browser.close()

  const failed = results.filter(r => !r.ok)
  console.log()
  console.log(`${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    console.log(`failures: ${failed.map(f => f.name).join(', ')}`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error('smoke-test-ui crashed:', e)
  process.exit(2)
})
