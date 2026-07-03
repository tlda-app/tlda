#!/usr/bin/env node
import { chromium } from 'playwright'
import WebSocket from 'ws'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=')
      return [k, v.join('=') || true]
    }),
)

const BASE = String(args.url || 'https://127.0.0.1:5190').replace(/\/+$/, '')
const DOC = String(args.doc || 'test-fleet')
const WIDTH = Number(args.width || 375)
const HEIGHT = Number(args.height || 664)

function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  return [
    'chromium-1226/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ].map(p => join(cache, p)).find(existsSync) || null
}

let token = ''
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.config/tlda/config.json'), 'utf8'))
  token = cfg.tokenRw || cfg.token || ''
} catch {
  // Token config is optional for tokenless dev previews.
}

const RUN = Date.now().toString(36)
const QA_NAME = `phone-eject-qa-${RUN}`
const QA_ID = `fleet:${QA_NAME}`
const QA_DEVICE_ID = `phone-eject-device-${RUN}`
const PARTNER = `phone-eject-agent-${RUN}`
const PARTNER_ID = `fleet:${PARTNER}`

function wsUrl() {
  return BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws/fleet'
}

async function fleetRequest(ws, msg) {
  const id = Math.floor(Math.random() * 1e9)
  const packet = { ...msg, id }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fleet ws timeout for ${msg.type}`)), 10000)
    const onMessage = raw => {
      let data
      try { data = JSON.parse(String(raw)) } catch { return }
      if (data.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      if (data.ok === false || data.error) reject(new Error(data.error || `${msg.type} failed`))
      else resolve(data)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify(packet))
  })
}

async function seedThread() {
  const ws = new WebSocket(wsUrl(), { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await fleetRequest(ws, { type: 'register', agent_id: PARTNER_ID, name: PARTNER, kind: 'codex' })
  await fleetRequest(ws, { type: 'chat', from: PARTNER_ID, to: QA_NAME, message: `phase 2 eject seed ${RUN}` })
  ws.close()
}

async function tapPhonePreset(page) {
  const pill = page.locator('.fleet-icon-pill-badge')
  await pill.waitFor({ state: 'visible', timeout: 15000 })
  await pill.tap()
  const phonePreset = page.locator('.corner-button-slider-slot[title^="Phone reset"]')
  await phonePreset.waitFor({ state: 'visible', timeout: 5000 })
  await phonePreset.tap()
  await page.waitForFunction(() => !!document.querySelector('.fleet-hud-wrap .fleet-inbox-shape'), null, { timeout: 10000 })
  await page.waitForFunction(() => {
    const until = Number(window.__tldaPhoneCameraSettlingUntil || 0)
    return !until || Date.now() >= until
  }, null, { timeout: 15000 })
}

async function openThread(page) {
  await page.waitForFunction((partner) => {
    return [...document.querySelectorAll('.fleet-hud-wrap .fleet-inbox-thread-partner')].some(el => el.textContent?.trim() === partner)
  }, PARTNER, { timeout: 15000 })
  await page.locator('.fleet-hud-wrap .fleet-inbox-thread').filter({ hasText: PARTNER }).first().dispatchEvent('pointerup', {
    pointerId: 10,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: 24,
    clientY: 48,
  })
  await page.locator('.fleet-hud-wrap .fleet-inbox-conv').waitFor({ state: 'visible', timeout: 5000 })
}

async function dispatchDrag(locator, points, pointerId) {
  const [first, ...rest] = points
  await locator.dispatchEvent('pointerdown', {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: first.x,
    clientY: first.y,
  })
  for (const p of rest) {
    await locator.dispatchEvent('pointermove', {
      pointerId,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: p.x,
      clientY: p.y,
    })
  }
  const last = rest[rest.length - 1] || first
  await locator.dispatchEvent('pointerup', {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: last.x,
    clientY: last.y,
  })
}

async function ownedChats(page) {
  return page.evaluate(({ humanId, deviceId }) => {
    const ed = window.__tldraw_editor__
    const pageShape = ed.getCurrentPageShapes().find(s => s.type === 'svg-page' || s.type === 'html-page')
    const pb = ed.getShapePageBounds(pageShape.id)
    const inbox = ed.getCurrentPageShapes().find(s =>
      s.type === 'fleet-inbox' &&
      s.props?.userId === humanId &&
      s.props?.deviceId === deviceId)
    const screenW = Math.round(ed.getViewportScreenBounds().w)
    const dx = inbox.x - (pb.x - screenW)
    const chats = ed.getCurrentPageShapes()
      .filter(s => s.type === 'fleet-chat' && s.props?.userId === humanId && s.props?.deviceId === deviceId)
      .map(s => ({
        id: s.id,
        x: s.x,
        y: s.y,
        w: s.props?.w,
        h: s.props?.h,
        locked: !!s.isLocked,
        filter: s.props?.filter,
        index: Math.round((pb.x + dx - s.x) / screenW),
      }))
      .sort((a, b) => a.index - b.index || String(a.id).localeCompare(String(b.id)))
    return { screenW, screenH: Math.round(ed.getViewportScreenBounds().h), docLeft: pb.x, dx, chats }
  }, { humanId: QA_ID, deviceId: QA_DEVICE_ID })
}

async function snapToInbox(page) {
  await page.evaluate(({ humanId, deviceId }) => {
    const ed = window.__tldraw_editor__
    const pageShape = ed.getCurrentPageShapes().find(s => s.type === 'svg-page' || s.type === 'html-page')
    const pb = ed.getShapePageBounds(pageShape.id)
    const cam = ed.getCamera()
    const screenW = Math.round(ed.getViewportScreenBounds().w)
    ed.setCamera({ ...cam, x: screenW / cam.z - pb.x }, { animation: { duration: 0 } })
  }, { humanId: QA_ID, deviceId: QA_DEVICE_ID })
  await page.waitForTimeout(300)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function main() {
  console.log(`phone-pane-eject-mobile url=${BASE}/?doc=${DOC} viewport=${WIDTH}x${HEIGHT}`)
  const executablePath = chromiumExecutable()
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  })
  await context.addInitScript(({ name, deviceId }) => {
    localStorage.setItem('tlda-identity', name)
    localStorage.setItem('tlda-device-id', deviceId)
  }, { name: QA_NAME, deviceId: QA_DEVICE_ID })
  const page = await context.newPage()
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`))
  page.on('console', m => {
    if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 240)}`)
  })

  const qs = new URLSearchParams({ doc: DOC, pw: '1', name: QA_NAME })
  if (token) qs.set('token', token)
  await page.goto(`${BASE}/?${qs.toString()}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__tldraw_editor__, null, { timeout: 45000 })
  await page.waitForFunction(() => window.__tldraw_editor__?.getCurrentPageShapes().some(s => s.type === 'svg-page' || s.type === 'html-page'), null, { timeout: 45000 })
  await page.waitForFunction(async (name) => {
    const res = await fetch('/api/state')
    if (!res.ok) return false
    const state = await res.json()
    return (state.agents || []).some(a => a.friendly_name === name && a.human)
  }, QA_NAME, { timeout: 15000 })

  await seedThread()
  await tapPhonePreset(page)
  await snapToInbox(page)
  await openThread(page)

  const conv = page.locator('.fleet-hud-wrap .fleet-inbox-conv')
  await dispatchDrag(conv, [{ x: 320, y: 320 }, { x: 300, y: 420 }, { x: 298, y: 520 }], 21)
  await page.waitForTimeout(250)
  let report = await ownedChats(page)
  assert(report.chats.length === 0, `vertical/short gesture created chat: ${JSON.stringify(report.chats)}`)

  await dispatchDrag(conv, [{ x: 340, y: 320 }, { x: 220, y: 324 }, { x: 120, y: 326 }, { x: 35, y: 328 }], 22)
  await page.waitForFunction(({ humanId, deviceId }) => {
    const ed = window.__tldraw_editor__
    return ed.getCurrentPageShapes().filter(s => s.type === 'fleet-chat' && s.props?.userId === humanId && s.props?.deviceId === deviceId).length === 1
  }, { humanId: QA_ID, deviceId: QA_DEVICE_ID }, { timeout: 5000 })
  report = await ownedChats(page)
  assert(report.chats.length === 1, `expected one pinned chat, got ${JSON.stringify(report.chats)}`)
  assert(report.chats[0].index === 2, `new chat not at pane index 2: ${JSON.stringify(report.chats[0])}`)
  assert(report.chats[0].w === report.screenW && report.chats[0].h === report.screenH, `new chat not full-screen: ${JSON.stringify(report.chats[0])}`)
  assert(report.chats[0].locked, `new chat not locked: ${JSON.stringify(report.chats[0])}`)
  assert(JSON.stringify(report.chats[0].filter) === JSON.stringify([[['from', PARTNER]], [['to', PARTNER]]]), `wrong filter: ${JSON.stringify(report.chats[0].filter)}`)

  await snapToInbox(page)
  await openThread(page)
  await dispatchDrag(page.locator('.fleet-hud-wrap .fleet-inbox-conv'), [{ x: 340, y: 320 }, { x: 220, y: 324 }, { x: 120, y: 326 }, { x: 35, y: 328 }], 23)
  await page.waitForFunction(({ humanId, deviceId }) => {
    const ed = window.__tldraw_editor__
    return ed.getCurrentPageShapes().filter(s => s.type === 'fleet-chat' && s.props?.userId === humanId && s.props?.deviceId === deviceId).length === 2
  }, { humanId: QA_ID, deviceId: QA_DEVICE_ID }, { timeout: 5000 })
  report = await ownedChats(page)
  assert(report.chats.map(c => c.index).join(',') === '2,3', `expected pinned indexes 2,3 after shift: ${JSON.stringify(report.chats)}`)

  console.log(JSON.stringify({
    viewport: { w: WIDTH, h: HEIGHT },
    partner: PARTNER,
    pinned: report.chats.map(c => ({ index: c.index, w: c.w, h: c.h, locked: c.locked })),
  }, null, 2))
  await browser.close()
}

main().catch(err => {
  console.error(`phone-pane-eject-mobile failed: ${err.message}`)
  process.exit(1)
})
