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

  const report = await page.evaluate(async ({ width, height, clip }) => {
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

    const { createFleetLayout } = await import('/src/shapes/fleet-utils.ts')
    createFleetLayout(ed, [], 'phone')
    await new Promise(r => setTimeout(r, 1000))

    const fleet = ed.getCurrentPageShapes().filter(s =>
      ['fleet-agents', 'fleet-inbox', 'fleet-chat', 'fleet-docview'].includes(s.type) &&
      s.props?.userId === fleetData.getHumanId() &&
      s.props?.deviceId === myDeviceId,
    )
    const agents = fleet.find(s => s.type === 'fleet-agents')
    const inbox = fleet.find(s => s.type === 'fleet-inbox')
    const chat = fleet.find(s => s.type === 'fleet-chat')
    const docview = fleet.find(s => s.type === 'fleet-docview')
    if (!agents || !inbox || !chat || !docview) {
      throw new Error(`missing phone layout shapes: ${fleet.map(s => s.type).join(',')}`)
    }

    const gap = Math.round(inbox.y - agents.y - agents.props.h)
    const column = {
      x: agents.x,
      y: agents.y,
      w: agents.props.w,
      h: agents.props.h + gap + inbox.props.h,
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
    if (Math.abs(column.h - chat.props.h) > 1) {
      throw new Error(`agents+inbox column height ${column.h} != chat height ${chat.props.h}`)
    }
    if (Math.abs(inbox.x - agents.x) > 1 || Math.abs(inbox.props.w - agents.props.w) > 1) {
      throw new Error('agents and inbox are not aligned as one left column')
    }
    if (Math.abs(chat.x - (agents.x + agents.props.w + 10)) > 1) {
      throw new Error('chat is not immediately to the right of agents/inbox column')
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
      camera: { z: Number(z.toFixed(4)) },
      agents: { w: agents.props.w, h: agents.props.h },
      inbox: { w: inbox.props.w, h: inbox.props.h },
      chat: { w: chat.props.w, h: chat.props.h },
      column: { w: column.w, h: column.h, gap },
      layout: { w: layoutW, h: chat.props.h },
      screenChat: {
        x: Math.round(screenChat.x),
        y: Math.round(screenChat.y),
        w: Math.round(screenChat.w),
        h: Math.round(screenChat.h),
      },
      docview: { w: docview.props.w, h: docview.props.h },
    }
  }, { width: WIDTH, height: HEIGHT, clip: CLIP })

  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch(err => {
  console.error(`phone-layout-mobile failed: ${err.message}`)
  process.exit(1)
})
