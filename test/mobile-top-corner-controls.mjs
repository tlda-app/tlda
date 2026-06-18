#!/usr/bin/env node
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { chromium, webkit } from 'playwright'

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=')
      return [k, v.join('=') || true]
    }),
)

const BASE = String(args.url || 'https://127.0.0.1:5179').replace(/\/+$/, '')
const DOC = String(args.doc || 'balancing-act')
const BROWSERS = String(args.browsers || 'chromium,webkit').split(',').map(s => s.trim()).filter(Boolean)

let token = ''
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.config/tlda/config.json'), 'utf8'))
  token = cfg.tokenRw || cfg.token || ''
} catch (e) {
  if (e?.code !== 'ENOENT') console.warn(`[config] unable to read token: ${e.message}`)
}

function urlFor(name) {
  const qs = new URLSearchParams({ doc: DOC, pw: '1', name })
  if (token) qs.set('token', token)
  return `${BASE}/?${qs.toString()}`
}

async function waitForViewer(page) {
  await page.goto(urlFor(`corner-${Date.now().toString(36)}`), { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => !!window.__tldraw_editor__, null, { timeout: 60000 })
  await page.waitForFunction(() => {
    const ed = window.__tldraw_editor__
    return ed?.getCurrentPageShapes().some(s => s.type === 'svg-page' || s.type === 'html-page')
  }, null, { timeout: 60000 })
  await page.waitForTimeout(500)
}

async function assertNoTopCornerInterception(page, selector) {
  const result = await page.locator(selector).evaluate(el => {
    const rect = el.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const top = document.elementFromPoint(x, y)
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      hit: top === el || el.contains(top),
      hitClass: top?.className?.toString() || top?.tagName || null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })
  if (!result.hit) throw new Error(`${selector} center is intercepted by ${result.hitClass}: ${JSON.stringify(result)}`)
  if (result.rect.width < 44 || result.rect.height < 44) {
    throw new Error(`${selector} touch target is too small: ${JSON.stringify(result.rect)}`)
  }
  if (result.rect.x < 0 || result.rect.y < 0 || result.rect.right > result.viewport.width || result.rect.bottom > result.viewport.height) {
    throw new Error(`${selector} is outside viewport: ${JSON.stringify(result)}`)
  }
}

async function checkPhone(browserType) {
  const browser = await browserType.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  page.on('pageerror', e => { throw e })
  try {
    await waitForViewer(page)
    await page.waitForSelector('.phone-toc-btn', { state: 'visible', timeout: 10000 })
    await assertNoTopCornerInterception(page, '.phone-toc-btn')
    await page.locator('.phone-toc-btn').click()
    await page.waitForSelector('.phone-toc-modal', { state: 'visible', timeout: 10000 })
    await assertNoTopCornerInterception(page, '.phone-toc-modal [aria-label="Settings"]')
    await page.locator('.phone-toc-modal [aria-label="Settings"]').click()
    await page.waitForSelector('.phone-toc-modal .prefs-tab', { state: 'visible', timeout: 10000 })
    const text = await page.locator('.phone-toc-modal .prefs-tab').innerText()
    if (!/theme/i.test(text)) throw new Error(`phone prefs did not render expected settings text: ${text.slice(0, 120)}`)
  } finally {
    await browser.close()
  }
}

async function checkTablet(browserType) {
  const browser = await browserType.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  page.on('pageerror', e => { throw e })
  try {
    await waitForViewer(page)
    await page.waitForSelector('.doc-panel', { state: 'visible', timeout: 10000 })
    await page.touchscreen.tap(816, 24)
    await page.waitForSelector('.doc-panel-open', { state: 'visible', timeout: 10000 })
    await assertNoTopCornerInterception(page, '.doc-panel-tab--gear')
    await page.locator('.doc-panel-tab--gear').click()
    await page.waitForSelector('.doc-panel .prefs-tab', { state: 'visible', timeout: 10000 })
  } finally {
    await browser.close()
  }
}

const browserMap = { chromium, webkit }
for (const name of BROWSERS) {
  const browserType = browserMap[name]
  if (!browserType) throw new Error(`unknown browser: ${name}`)
  console.log(`[${name}] phone top-right menu/settings`)
  await checkPhone(browserType)
  console.log(`[${name}] tablet top-right panel/settings`)
  await checkTablet(browserType)
}

console.log('mobile top-corner controls smoke passed')
