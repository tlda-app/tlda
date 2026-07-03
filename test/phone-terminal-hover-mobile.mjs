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
const QA_NAME = `phone-term-qa-${RUN}`
const QA_ID = `fleet:${QA_NAME}`
const QA_DEVICE_ID = `phone-term-device-${RUN}`
const PARTNER = `phone-term-agent-${RUN}`
const PARTNER_ID = `fleet:${PARTNER}`
const CHAT_ID = `shape:phone-term-chat-${RUN}`

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

async function seedTerminalAgent() {
  const ws = new WebSocket(wsUrl(), { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await fleetRequest(ws, {
    type: 'register',
    agent_id: PARTNER_ID,
    name: PARTNER,
    kind: 'codex',
    status: 'awake',
    machine_id: `phone-term-machine-${RUN}`,
    tmux_session: `phone-term-tmux-${RUN}`,
  })
  await fleetRequest(ws, { type: 'chat', from: PARTNER_ID, to: QA_NAME, message: `terminal hover seed ${RUN}` })
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

async function createPhoneChatPane(page) {
  await page.evaluate(({ chatId, humanId, deviceId, partner }) => {
    const ed = window.__tldraw_editor__
    const pageShape = ed.getCurrentPageShapes().find(s => s.type === 'svg-page' || s.type === 'html-page')
    if (!pageShape) throw new Error('no document page shape')
    const pb = ed.getShapePageBounds(pageShape.id)
    const inbox = ed.getCurrentPageShapes().find(s =>
      s.type === 'fleet-inbox' &&
      s.props?.userId === humanId &&
      s.props?.deviceId === deviceId)
    if (!inbox) throw new Error('no owned phone inbox')
    const cam = ed.getCamera()
    const screen = ed.getViewportScreenBounds()
    const screenW = Math.round(screen.w)
    const screenH = Math.round(screen.h)
    const chatX = pb.x - (2 * screenW)
    const chatY = inbox.y || pb.y
    ed.createShape({
      id: chatId,
      type: 'fleet-chat',
      x: chatX,
      y: chatY,
      isLocked: true,
      props: {
        w: screenW,
        h: screenH,
        filter: [[['from', partner]], [['to', partner]]],
        trafficMode: 'normal',
        userId: humanId,
        deviceId,
      },
    })
    ed.setCamera({ ...cam, x: (2 * screenW) / cam.z - pb.x }, { animation: { duration: 0 } })
  }, { chatId: CHAT_ID, humanId: QA_ID, deviceId: QA_DEVICE_ID, partner: PARTNER })
  await page.waitForTimeout(500)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function main() {
  console.log(`phone-terminal-hover-mobile url=${BASE}/?doc=${DOC} viewport=${WIDTH}x${HEIGHT}`)
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

  await seedTerminalAgent()
  await tapPhonePreset(page)
  await createPhoneChatPane(page)

  try {
    await page.waitForFunction((partner) => {
      return [...document.querySelectorAll('.fleet-hud-wrap .fleet-terminal-icon')]
        .some(el => (el.getAttribute('title') || '').includes(partner))
    }, PARTNER, { timeout: 15000 })
  } catch (err) {
    const diag = await page.evaluate(({ humanId, deviceId, partner, partnerId, chatId }) => {
      const ed = window.__tldraw_editor__
      const chat = ed?.getCurrentPageShapes?.().find(s => s.id === chatId)
      return {
        agents: window.__tldaFleetAgentsForDebug || null,
        stateAgents: null,
        chat: chat ? {
          id: chat.id,
          type: chat.type,
          x: chat.x,
          y: chat.y,
          props: chat.props,
          locked: !!chat.isLocked,
        } : null,
        visibleChats: [...document.querySelectorAll('.fleet-hud-wrap .fleet-chat-shape')].map(el => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height, text: el.textContent?.slice(0, 120) }
        }),
        iconTitles: [...document.querySelectorAll('.fleet-hud-wrap .fleet-terminal-icon')].map(el => el.getAttribute('title')),
        humanId,
        deviceId,
        partner,
        partnerId,
      }
    }, { humanId: QA_ID, deviceId: QA_DEVICE_ID, partner: PARTNER, partnerId: PARTNER_ID, chatId: CHAT_ID })
    try {
      const state = await page.evaluate(async () => {
        const res = await fetch('/api/state')
        return res.ok ? await res.json() : { error: res.status }
      })
      diag.stateAgents = (state.agents || []).filter(a => a.id === PARTNER_ID || a.friendly_name === PARTNER)
    } catch (stateErr) {
      diag.stateAgents = { error: stateErr?.message || String(stateErr) }
    }
    throw new Error(`terminal icon did not render: ${JSON.stringify(diag)}`)
  }
  await page.evaluate((partner) => {
    const icon = [...document.querySelectorAll('.fleet-hud-wrap .fleet-terminal-icon')]
      .find(el => (el.getAttribute('title') || '').includes(partner))
    if (!(icon instanceof HTMLElement)) throw new Error(`terminal icon not found for ${partner}`)
    icon.click()
  }, PARTNER)
  await page.locator('.fleet-terminal-hover-pane').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(250)

  const report = await page.evaluate(() => {
    const pane = document.querySelector('.fleet-terminal-hover-pane')
    const body = document.querySelector('.fleet-terminal-hover-body')
    const handle = document.querySelector('.fleet-terminal-hover-resize-handle')
    if (!(pane instanceof HTMLElement)) throw new Error('terminal hover pane did not render')
    const r = pane.getBoundingClientRect()
    const br = body instanceof HTMLElement ? body.getBoundingClientRect() : null
    return {
      viewport: {
        width: window.visualViewport?.width || window.innerWidth,
        height: window.visualViewport?.height || window.innerHeight,
      },
      pane: { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom },
      body: br ? { x: br.x, y: br.y, width: br.width, height: br.height } : null,
      hasResizeHandle: !!handle,
      inputMode: document.querySelector('.fleet-terminal-hover-input')?.getAttribute('inputmode') || '',
    }
  })

  const expectedH = report.viewport.height * 0.5
  assert(Math.abs(report.pane.x) <= 1, `phone terminal pane is not left-aligned: ${JSON.stringify(report)}`)
  assert(Math.abs(report.pane.y) <= 1, `phone terminal pane is not top-aligned: ${JSON.stringify(report)}`)
  assert(Math.abs(report.pane.width - report.viewport.width) <= 2, `phone terminal pane width is not viewport width: ${JSON.stringify(report)}`)
  assert(Math.abs(report.pane.height - expectedH) <= 3, `phone terminal pane height is not half viewport: ${JSON.stringify(report)}`)
  assert(report.pane.bottom < report.viewport.height, `phone terminal pane should sit above chat, not below it: ${JSON.stringify(report)}`)
  assert(report.body && report.body.height > 40, `terminal body did not flex inside phone pane: ${JSON.stringify(report)}`)
  assert(!report.hasResizeHandle, `phone terminal pane should not show resize handle: ${JSON.stringify(report)}`)
  assert(report.inputMode === 'none', `phone terminal input should keep inputMode=none: ${JSON.stringify(report)}`)

  console.log(JSON.stringify({
    viewport: { w: WIDTH, h: HEIGHT },
    partner: PARTNER,
    pane: report.pane,
    inputMode: report.inputMode,
  }, null, 2))
  await browser.close()
}

main().catch(err => {
  console.error(`phone-terminal-hover-mobile failed: ${err.message}`)
  process.exit(1)
})
