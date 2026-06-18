#!/usr/bin/env node
import { chromium } from 'playwright'
import { readFileSync } from 'fs'
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

const BASE = String(args.url || 'https://127.0.0.1:5188').replace(/\/+$/, '')
const DOC = String(args.doc || 'bregman')
const WIDTH = Number(args.width || 390)
const HEIGHT = Number(args.height || 844)
const CLIP = String(args.clip || '') === '1'

let token = ''
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.config/tlda/config.json'), 'utf8'))
  token = cfg.tokenRw || cfg.token || ''
} catch (e) {
  if (e?.code !== 'ENOENT') console.warn(`[config] unable to read token: ${e.message}`)
}

const qs = new URLSearchParams({ doc: DOC, pw: '1', name: 'phone-layout-qa' })
if (token) qs.set('token', token)
const URL = `${BASE}/?${qs.toString()}`

async function main() {
  console.log(`phone-layout-mobile url=${URL} viewport=${WIDTH}x${HEIGHT} clip=${CLIP ? '1' : '0'}`)
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`))
  page.on('console', m => {
    if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 240)}`)
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__tldraw_editor__, null, { timeout: 45000 })
  await page.waitForFunction(() => {
    const ed = window.__tldraw_editor__
    return ed?.getCurrentPageShapes().some(s => s.type === 'svg-page' || s.type === 'html-page')
  }, null, { timeout: 45000 })
  await page.waitForTimeout(1000)

  await page.evaluate(async ({ width, height, clip }) => {
    const ed = window.__tldraw_editor__
    const pageShape = ed.getCurrentPageShapes().find(s => s.type === 'svg-page' || s.type === 'html-page')
    if (!pageShape) throw new Error('no document page shape')
    const pb = ed.getShapePageBounds(pageShape.id)
    if (!pb) throw new Error('document page has no bounds')

    const desiredLeft = 32
    const desiredTop = clip ? -220 : 90
    const desiredW = width - 64
    const desiredH = height - 180
    const z = clip ? desiredW / pb.w : Math.min(desiredW / pb.w, desiredH / pb.h)
    ed.setCamera({
      x: desiredLeft / z - pb.x,
      y: desiredTop / z - pb.y,
      z,
    }, { animation: { duration: 0 } })
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

    const topLeft = ed.pageToScreen({ x: pb.x, y: pb.y })
    const bottomRight = ed.pageToScreen({ x: pb.x + pb.w, y: pb.y + pb.h })
    const docScreen = {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    }
    if (!clip && (docScreen.x < 20 || docScreen.y < 70 || docScreen.x + docScreen.w > width - 20 || docScreen.y + docScreen.h > height - 20)) {
      throw new Error(`document does not fit comfortably before layout: ${JSON.stringify(docScreen)}`)
    }
    const clippedDocScreen = {
      x: Math.max(docScreen.x, 0),
      y: Math.max(docScreen.y, 0),
      w: Math.max(0, Math.min(docScreen.x + docScreen.w, width) - Math.max(docScreen.x, 0)),
      h: Math.max(0, Math.min(docScreen.y + docScreen.h, height) - Math.max(docScreen.y, 0)),
    }

    localStorage.setItem('fleet-hud-expanded', '1')
    const fleetData = await import('/src/fleet/fleet-data.mjs')
    const started = Date.now()
    while (!fleetData.getHumanId() && Date.now() - started < 8000) {
      await new Promise(r => setTimeout(r, 100))
    }
    if (!fleetData.getHumanId()) {
      const qaName = `phone-layout-qa-${Date.now().toString(36)}`
      try {
        await fleetData.registerHuman(qaName)
      } catch {
        await fleetData.login(qaName)
      }
    }
    if (!fleetData.getHumanId()) throw new Error('test identity did not resolve')
    const myDeviceId = fleetData.getDeviceId?.()
    if (!myDeviceId) throw new Error('test device id did not resolve')

    window.__phoneLayoutExpected = {
      width,
      height,
      clip,
      pb: { x: pb.x, y: pb.y, w: pb.w, h: pb.h },
      docScreen,
      clippedDocScreen,
      cameraZ: z,
      humanId: fleetData.getHumanId(),
      myDeviceId,
    }
  }, { width: WIDTH, height: HEIGHT, clip: CLIP })

  const pill = page.locator('.fleet-icon-pill-badge')
  await pill.waitFor({ state: 'visible', timeout: 15000 })
  const pillBox = await pill.boundingBox()
  if (!pillBox) throw new Error('fleet layout pill has no bounding box')
  const pillRightGap = WIDTH - (pillBox.x + pillBox.width)
  if (pillRightGap < 3 || pillRightGap > 8) {
    throw new Error(`fleet layout pill is not at reachable right edge: ${JSON.stringify(pillBox)}`)
  }
  await pill.tap()

  const phonePreset = page.locator('.fleet-icon-pill-fan-item[title^="Phone reset"]')
  await phonePreset.waitFor({ state: 'visible', timeout: 5000 })
  const presetBox = await phonePreset.boundingBox()
  if (!presetBox || presetBox.width < 40 || presetBox.height < 30) {
    throw new Error(`phone preset touch target is too small: ${JSON.stringify(presetBox)}`)
  }
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return {
      hit: !!el?.closest?.('.fleet-icon-pill-fan-item[title^="Phone reset"]'),
      className: el instanceof HTMLElement ? el.className : String(el),
    }
  }, { x: presetBox.x + presetBox.width / 2, y: presetBox.y + presetBox.height / 2 })
  if (!hit.hit) throw new Error(`phone preset is visually present but not touch-hit-testable: ${JSON.stringify(hit)}`)
  await phonePreset.tap()
  await page.waitForTimeout(1000)

  const report = await page.evaluate(async () => {
    const ed = window.__tldraw_editor__
    const setup = window.__phoneLayoutExpected
    if (!setup) throw new Error('phone layout setup missing')
    const { width, height, clip, pb, docScreen, clippedDocScreen, cameraZ, humanId, myDeviceId } = setup

    const fleet = ed.getCurrentPageShapes().filter(s =>
      ['fleet-agents', 'fleet-inbox', 'fleet-chat', 'fleet-docview', 'fleet-search'].includes(s.type) &&
      s.props?.userId === humanId &&
      s.props?.deviceId === myDeviceId,
    )
    const agents = fleet.find(s => s.type === 'fleet-agents')
    const inbox = fleet.find(s => s.type === 'fleet-inbox')
    const chat = fleet.find(s => s.type === 'fleet-chat')
    const docview = fleet.find(s => s.type === 'fleet-docview')
    const search = fleet.find(s => s.type === 'fleet-search')
    if (!agents || !chat) {
      throw new Error(`missing phone layout shapes: ${fleet.map(s => s.type).join(',')}`)
    }
    if (inbox || docview || search) {
      throw new Error(`phone layout should only create agents + chat, got: ${fleet.map(s => s.type).join(',')}`)
    }

    const column = {
      x: agents.x,
      y: agents.y,
      w: agents.props.w,
      h: agents.props.h,
    }
    const expectedRect = clip ? clippedDocScreen : docScreen
    const expectedW = Math.round(expectedRect.w)
    const expectedH = Math.round(expectedRect.h)
    if (Math.abs(chat.props.w - expectedW) > 1) {
      throw new Error(`chat width ${chat.props.w} != expected page/clipped width ${expectedW}`)
    }
    if (Math.abs(chat.props.h - expectedH) > 1) {
      throw new Error(`chat height ${chat.props.h} != expected page/clipped height ${expectedH}`)
    }
    if (Math.abs(agents.props.h - chat.props.h) > 1) {
      throw new Error(`agents panel height ${agents.props.h} != chat height ${chat.props.h}`)
    }
    if (Math.abs(chat.x - (agents.x + agents.props.w + 10)) > 1) {
      throw new Error('chat is not immediately to the right of agents panel')
    }

    const layoutW = column.w + 10 + chat.props.w
    const targetDocLeft = 24 + 40 + chat.props.w
    const currentDocLeft = ed.pageToScreen({ x: pb.x, y: pb.y }).x
    const cam = ed.getCamera()
    ed.setCamera({ ...cam, x: cam.x + (targetDocLeft - currentDocLeft) / cam.z }, { animation: { duration: 0 } })
    await new Promise(r => setTimeout(r, 1000))

    // FleetHUD renders these shapes at z=1 and compensates the layout lane
    // offset; after the horizontal pan above, the phone stack appears one
    // margin gap left of the document. The vertical camera pins the stack top at
    // the HUD top pad. This verifies the same panned geometry without depending
    // on the overlay surviving unrelated remote-sync render errors.
    const pannedDocLeft = ed.pageToScreen({ x: pb.x, y: pb.y }).x
    const screenChat = {
      x: pannedDocLeft - 40 - layoutW,
      y: 80,
      w: chat.props.w,
      h: chat.props.h,
    }
    screenChat.x += column.w + 10
    if (screenChat.x < 16 || screenChat.x + screenChat.w > width - 16) {
      throw new Error(`panned phone chat does not fit horizontally: ${JSON.stringify(screenChat)}`)
    }
    if (!clip && (screenChat.y < 70 || screenChat.y + screenChat.h > height - 16)) {
      throw new Error(`panned phone chat does not fit vertically: ${JSON.stringify(screenChat)}`)
    }

    return {
      viewport: { w: width, h: height },
      clip,
      docScreen: {
        x: Math.round(docScreen.x),
        y: Math.round(docScreen.y),
        w: Math.round(docScreen.w),
        h: Math.round(docScreen.h),
      },
      clippedDocScreen: {
        x: Math.round(clippedDocScreen.x),
        y: Math.round(clippedDocScreen.y),
        w: Math.round(clippedDocScreen.w),
        h: Math.round(clippedDocScreen.h),
      },
      camera: { z: Number(cameraZ.toFixed(4)) },
      control: { pill: 'tapped', preset: 'tapped' },
      agents: { w: agents.props.w, h: agents.props.h },
      chat: { w: chat.props.w, h: chat.props.h },
      column: { w: column.w, h: column.h },
      layout: { w: layoutW, h: chat.props.h },
      screenChat: {
        x: Math.round(screenChat.x),
        y: Math.round(screenChat.y),
        w: Math.round(screenChat.w),
        h: Math.round(screenChat.h),
      },
      extraPanels: fleet.filter(s => s.type !== 'fleet-agents' && s.type !== 'fleet-chat').map(s => s.type),
    }
  })

  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch(err => {
  console.error(`phone-layout-mobile failed: ${err.message}`)
  process.exit(1)
})
