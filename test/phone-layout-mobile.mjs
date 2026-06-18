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
  console.log(`phone-layout-mobile url=${URL} viewport=${WIDTH}x${HEIGHT}`)
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

  const report = await page.evaluate(async ({ width, height }) => {
    const ed = window.__tldraw_editor__
    const pageShape = ed.getCurrentPageShapes().find(s => s.type === 'svg-page' || s.type === 'html-page')
    if (!pageShape) throw new Error('no document page shape')
    const pb = ed.getShapePageBounds(pageShape.id)
    if (!pb) throw new Error('document page has no bounds')

    const desiredLeft = 32
    const desiredTop = 90
    const desiredW = width - 64
    const desiredH = height - 180
    const z = Math.min(desiredW / pb.w, desiredH / pb.h)
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
    if (docScreen.x < 20 || docScreen.y < 70 || docScreen.x + docScreen.w > width - 20 || docScreen.y + docScreen.h > height - 20) {
      throw new Error(`document does not fit comfortably before layout: ${JSON.stringify(docScreen)}`)
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

    const { createFleetLayout } = await import('/src/shapes/fleet-utils.ts')
    createFleetLayout(ed, [], 'phone')
    await new Promise(r => setTimeout(r, 1000))

    const fleet = ed.getCurrentPageShapes().filter(s =>
      ['fleet-agents', 'fleet-chat', 'fleet-docview'].includes(s.type) &&
      s.props?.userId === fleetData.getHumanId(),
    )
    const agents = fleet.find(s => s.type === 'fleet-agents')
    const chat = fleet.find(s => s.type === 'fleet-chat')
    const docview = fleet.find(s => s.type === 'fleet-docview')
    if (!agents || !chat || !docview) {
      throw new Error(`missing phone layout shapes: ${fleet.map(s => s.type).join(',')}`)
    }

    const gap = Math.round(chat.y - agents.y - agents.props.h)
    const stack = {
      x: agents.x,
      y: agents.y,
      w: agents.props.w,
      h: agents.props.h + gap + chat.props.h,
    }
    const expectedW = Math.round(docScreen.w)
    const expectedH = Math.round(docScreen.h)
    if (Math.abs(stack.w - expectedW) > 1) {
      throw new Error(`stack width ${stack.w} != page screen width ${expectedW}`)
    }
    if (Math.abs(stack.h - expectedH) > 1) {
      throw new Error(`stack height ${stack.h} != page screen height ${expectedH}`)
    }
    if (Math.abs(chat.x - agents.x) > 1 || Math.abs(chat.props.w - agents.props.w) > 1) {
      throw new Error('agents and chat are not aligned as one stacked phone layout')
    }

    const targetDocLeft = 24 + 40 + stack.w
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
    const screenStack = {
      x: pannedDocLeft - 40 - stack.w,
      y: 80,
      w: stack.w,
      h: stack.h,
    }
    if (screenStack.x < 16 || screenStack.x + screenStack.w > width - 16) {
      throw new Error(`panned phone stack does not fit horizontally: ${JSON.stringify(screenStack)}`)
    }
    if (screenStack.y < 70 || screenStack.y + screenStack.h > height - 16) {
      throw new Error(`panned phone stack does not fit vertically: ${JSON.stringify(screenStack)}`)
    }

    return {
      viewport: { w: width, h: height },
      docScreen: {
        x: Math.round(docScreen.x),
        y: Math.round(docScreen.y),
        w: Math.round(docScreen.w),
        h: Math.round(docScreen.h),
      },
      camera: { z: Number(z.toFixed(4)) },
      agents: { w: agents.props.w, h: agents.props.h },
      chat: { w: chat.props.w, h: chat.props.h },
      stack: { w: stack.w, h: stack.h, gap },
      screenStack: {
        x: Math.round(screenStack.x),
        y: Math.round(screenStack.y),
        w: Math.round(screenStack.w),
        h: Math.round(screenStack.h),
      },
      docview: { w: docview.props.w, h: docview.props.h },
    }
  }, { width: WIDTH, height: HEIGHT })

  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch(err => {
  console.error(`phone-layout-mobile failed: ${err.message}`)
  process.exit(1)
})
