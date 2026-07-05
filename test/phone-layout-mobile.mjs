#!/usr/bin/env node
import { chromium } from 'playwright'
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

const BASE = String(args.url || 'https://127.0.0.1:5188').replace(/\/+$/, '')
const DOC = String(args.doc || 'test-fleet')
const WIDTH = Number(args.width || 390)
const HEIGHT = Number(args.height || 844)
const CLIP = String(args.clip || '') === '1'

function findChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  const candidates = [
    'chromium-1226/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ]
  return candidates.map(p => join(cache, p)).find(existsSync) || null
}

let token = ''
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.config/tlda/config.json'), 'utf8'))
  token = cfg.tokenRw || cfg.token || ''
} catch (e) {
  if (e?.code !== 'ENOENT') console.warn(`[config] unable to read token: ${e.message}`)
}

const QA_NAME = `phone-layout-qa-${Date.now().toString(36)}`
const QA_ID = `fleet:${QA_NAME}`
const QA_DEVICE_ID = `phone-layout-device-${Date.now().toString(36)}`
const qs = new URLSearchParams({ doc: DOC, pw: '1', name: QA_NAME })
if (token) qs.set('token', token)
const URL = `${BASE}/?${qs.toString()}`

async function main() {
  console.log(`phone-layout-mobile url=${URL} viewport=${WIDTH}x${HEIGHT} clip=${CLIP ? '1' : '0'}`)
  const executablePath = findChromiumExecutable()
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

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__tldraw_editor__, null, { timeout: 45000 })
  await page.waitForFunction(() => {
    const ed = window.__tldraw_editor__
    return ed?.getCurrentPageShapes().some(s => s.type === 'svg-page' || s.type === 'html-page')
  }, null, { timeout: 45000 })
  await page.waitForFunction(() => !!window.__tldaCameraRestoredAt, null, { timeout: 15000 })
  await page.waitForFunction(() => {
    const until = Number(window.__tldaPhoneCameraSettlingUntil || 0)
    return !until || Date.now() >= until
  }, null, { timeout: 15000 })
  await page.waitForFunction(async (name) => {
    const res = await fetch('/api/state')
    if (!res.ok) return false
    const state = await res.json()
    return (state.agents || []).some(a => a.friendly_name === name && a.human)
  }, QA_NAME, { timeout: 15000 })
  await page.waitForTimeout(100)

  await page.evaluate(async ({ width, height, clip, qaId }) => {
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

    const humanId = qaId
    const myDeviceId = localStorage.getItem('tlda-device-id')
    if (!myDeviceId) throw new Error('test device id did not resolve')
    const alienDeviceId = `${myDeviceId}-alien`
    const alienId = `shape:phone-layout-alien-${Date.now().toString(36)}`
    ed.createShape({
      id: alienId,
      type: 'fleet-chat',
      x: pb.x - 700,
      y: pb.y,
      props: {
        w: 180,
        h: 180,
        filter: [],
        userId: humanId,
        deviceId: alienDeviceId,
      },
    })

    window.__phoneLayoutExpected = {
      width,
      height,
      clip,
      pb: { x: pb.x, y: pb.y, w: pb.w, h: pb.h },
      docScreen,
      clippedDocScreen,
      cameraZ: z,
      humanId,
      myDeviceId,
      alienId,
    }
  }, { width: WIDTH, height: HEIGHT, clip: CLIP, qaId: QA_ID })

  const pill = page.locator('.fleet-icon-pill-badge')
  await pill.waitFor({ state: 'visible', timeout: 15000 })
  const pillBox = await pill.boundingBox()
  if (!pillBox) throw new Error('fleet layout pill has no bounding box')
  const pillRightGap = WIDTH - (pillBox.x + pillBox.width)
  if (pillRightGap < 3 || pillRightGap > 8) {
    throw new Error(`fleet layout pill is not at reachable right edge: ${JSON.stringify(pillBox)}`)
  }
  await pill.tap()

  const phonePresetSelector = '.fleet-icon-pill-fan-item[title^="Phone reset"], .corner-button-slider-slot[title^="Phone reset"]'
  const phonePreset = page.locator(phonePresetSelector)
  await phonePreset.waitFor({ state: 'visible', timeout: 5000 })
  const presetBox = await phonePreset.boundingBox()
  if (!presetBox || presetBox.width < 40 || presetBox.height < 30) {
    throw new Error(`phone preset touch target is too small: ${JSON.stringify(presetBox)}`)
  }
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return {
      hit: !!el?.closest?.('.fleet-icon-pill-fan-item[title^="Phone reset"], .corner-button-slider-slot[title^="Phone reset"]'),
      className: el instanceof HTMLElement ? el.className : String(el),
    }
  }, { x: presetBox.x + presetBox.width / 2, y: presetBox.y + presetBox.height / 2 })
  if (!hit.hit) throw new Error(`phone preset is visually present but not touch-hit-testable: ${JSON.stringify(hit)}`)
  await phonePreset.tap()
  await page.waitForFunction(() => !!window.__tldraw_hud_editor__, null, { timeout: 10000 })
  await page.waitForFunction(() => !!document.querySelector('.fleet-hud-wrap .fleet-chat-shape .fleet-chat-input-area textarea'), null, { timeout: 10000 })
  await page.waitForTimeout(500)

  const report = await page.evaluate(async () => {
    const ed = window.__tldraw_editor__
    const setup = window.__phoneLayoutExpected
    if (!setup) throw new Error('phone layout setup missing')
    const { width, height, clip, pb, docScreen, clippedDocScreen, cameraZ, humanId, myDeviceId, alienId } = setup

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
    if (!agents || !inbox || !chat) {
      throw new Error(`missing phone layout shapes: ${fleet.map(s => s.type).join(',')}`)
    }
    if (docview || search) {
      throw new Error(`phone layout should only create agents + inbox + chat, got: ${fleet.map(s => s.type).join(',')}`)
    }
    for (const panel of [agents, inbox, chat]) {
      if (!panel.isLocked) throw new Error(`phone layout panel should be locked/fixed: ${panel.type}`)
    }

    const column = {
      x: agents.x,
      y: agents.y,
      w: agents.props.w,
      h: agents.props.h + 10 + inbox.props.h,
    }
    const expectedW = width
    const expectedH = height
    if (Math.abs(chat.props.w - expectedW) > 1) {
      throw new Error(`chat width ${chat.props.w} != expected screen width ${expectedW}`)
    }
    if (Math.abs(chat.props.h - expectedH) > 1) {
      throw new Error(`chat height ${chat.props.h} != expected screen height ${expectedH}`)
    }
    if (Math.abs(agents.props.w - expectedW) > 1 || Math.abs(inbox.props.w - expectedW) > 1) {
      throw new Error(`left lane panels are not screen width: agents=${agents.props.w}, inbox=${inbox.props.w}, expected=${expectedW}`)
    }
    if (agents.props.h >= chat.props.h * 0.5) {
      throw new Error(`agents panel is too tall for phone layout: agents=${agents.props.h}, chat=${chat.props.h}`)
    }
    if (Math.abs(inbox.y - (agents.y + agents.props.h + 10)) > 1) {
      throw new Error('inbox is not stacked directly below agents panel')
    }
    if (Math.abs(inbox.props.h + agents.props.h + 10 - chat.props.h) > 1) {
      throw new Error(`left column height ${agents.props.h + 10 + inbox.props.h} != chat height ${chat.props.h}`)
    }
    if (Math.abs(chat.x - (agents.x + agents.props.w)) > 1) {
      throw new Error('chat lane is not immediately to the right of agents/inbox lane')
    }
    const layoutDx = (chat.x + chat.props.w) - pb.x
    if (!Number.isFinite(layoutDx)) {
      throw new Error(`phone layout/document offset is not finite: chatRight=${chat.x + chat.props.w} docLeft=${pb.x}`)
    }
    const visibleHudIds = Array.from(document.querySelectorAll('.fleet-hud-wrap [data-shape-id]'))
      .map(el => el.getAttribute('data-shape-id'))
      .filter(Boolean)
    if (visibleHudIds.includes(alienId)) {
      throw new Error(`HUD rendered same-user other-device fleet shape: ${alienId}`)
    }

    const layoutW = column.w + chat.props.w
    const laneStops = {
      agentsInbox: width * 2,
      chat: width,
      document: 0,
    }
    const cam = ed.getCamera()
    ed.setCamera({ ...cam, x: laneStops.chat / cam.z - pb.x }, { animation: { duration: 0 } })
    await new Promise(r => setTimeout(r, 1000))

    // FleetHUD renders these shapes at z=1 and compensates the layout lane
    // offset; with the document page snapped one screen to the right, the chat
    // lane occupies the phone viewport. The vertical camera pins the stack top
    // to the viewport top for full-screen phone lanes. This verifies the same panned geometry without
    // depending on the overlay surviving unrelated remote-sync render errors.
    const pannedDocLeft = ed.pageToScreen({ x: pb.x, y: pb.y }).x
    const screenChat = {
      x: pannedDocLeft - layoutW,
      y: 0,
      w: chat.props.w,
      h: chat.props.h,
    }
    screenChat.x += column.w
    if (Math.abs(screenChat.x) > 2 || Math.abs(screenChat.x + screenChat.w - width) > 2) {
      throw new Error(`panned phone chat does not fit horizontally: ${JSON.stringify(screenChat)}`)
    }
    if (!clip && (Math.abs(screenChat.y) > 2 || Math.abs(screenChat.y + screenChat.h - height) > 2)) {
      throw new Error(`panned phone chat does not fit vertically: ${JSON.stringify(screenChat)}`)
    }
    const chatEl = document.querySelector(`.fleet-hud-wrap [data-shape-id="${chat.id}"] .fleet-chat-shape`)
      || document.querySelector(`.fleet-hud-wrap [data-shape-id="${chat.id}"]`)
    if (!(chatEl instanceof HTMLElement)) throw new Error(`HUD did not render phone chat shape ${chat.id}`)
    const chatBox = chatEl.getBoundingClientRect()
    if (Math.abs(chatBox.width - chat.props.w) > 2 || Math.abs(chatBox.height - chat.props.h) > 2) {
      throw new Error(`HUD chat DOM size does not match shape props: dom=${JSON.stringify({ w: chatBox.width, h: chatBox.height })} props=${JSON.stringify({ w: chat.props.w, h: chat.props.h })}`)
    }
    if (Math.abs(chatBox.x) > 2 || Math.abs(chatBox.y) > 2 || Math.abs(chatBox.right - width) > 2 || Math.abs(chatBox.bottom - height) > 2) {
      throw new Error(`HUD phone chat DOM is clipped or inset: ${JSON.stringify({ x: chatBox.x, y: chatBox.y, right: chatBox.right, bottom: chatBox.bottom, width, height })}`)
    }
    const textarea = chatEl.querySelector('.fleet-chat-input-area textarea')
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('HUD phone chat textarea did not render')
    const taBox = textarea.getBoundingClientRect()
    const hitEl = document.elementFromPoint(taBox.left + taBox.width / 2, taBox.top + taBox.height / 2)
    if (!hitEl || !hitEl.closest('.fleet-chat-input-area textarea')) {
      throw new Error(`HUD phone chat textarea is not hit-testable: hit=${hitEl instanceof HTMLElement ? hitEl.className : String(hitEl)} chatBox=${JSON.stringify({ x: chatBox.x, y: chatBox.y, w: chatBox.width, h: chatBox.height })} textarea=${JSON.stringify({ x: taBox.x, y: taBox.y, w: taBox.width, h: taBox.height })}`)
    }

    ed.setCamera({ ...ed.getCamera(), x: laneStops.agentsInbox / cam.z - pb.x }, { animation: { duration: 0 } })
    await new Promise(r => setTimeout(r, 1000))
    const inboxEl = document.querySelector(`.fleet-hud-wrap [data-shape-id="${inbox.id}"] .fleet-inbox-shape`)
      || document.querySelector(`.fleet-hud-wrap [data-shape-id="${inbox.id}"]`)
    if (!(inboxEl instanceof HTMLElement)) throw new Error(`HUD did not render phone inbox shape ${inbox.id}`)
    const inboxBox = inboxEl.getBoundingClientRect()
    if (Math.abs(inboxBox.x) > 2 || Math.abs(inboxBox.right - width) > 2) {
      throw new Error(`HUD phone inbox lane is not screen-width aligned: ${JSON.stringify({ x: inboxBox.x, right: inboxBox.right, width })}`)
    }
    const filterButton = inboxEl.querySelector('.fleet-inbox-filter-btn')
    if (!(filterButton instanceof HTMLElement)) throw new Error('phone inbox filter button did not render')
    const filterButtonBox = filterButton.getBoundingClientRect()
    const filterButtonHit = document.elementFromPoint(
      filterButtonBox.left + filterButtonBox.width / 2,
      filterButtonBox.top + filterButtonBox.height / 2,
    )
    if (!filterButtonHit || !filterButtonHit.closest('.fleet-inbox-filter-btn')) {
      throw new Error(`phone inbox filter button is not hit-testable: hit=${filterButtonHit instanceof HTMLElement ? filterButtonHit.className : String(filterButtonHit)}`)
    }
    ed.updateShape({ id: chat.id, type: 'fleet-chat', isLocked: false })
    ed.updateShape({
      id: chat.id,
      type: 'fleet-chat',
      props: { ...chat.props, filter: [[['from', 'phone-layout-sentinel']]] },
    })
    ed.updateShape({ id: chat.id, type: 'fleet-chat', isLocked: true })
    await new Promise(r => setTimeout(r, 250))
    filterButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
    await new Promise(r => setTimeout(r, 250))
    const overlay = inboxEl.querySelector('.fleet-filter-overlay')
    if (!(overlay instanceof HTMLElement)) throw new Error('phone inbox did not open the chat filter overlay')
    const overlayBox = overlay.getBoundingClientRect()
    if (overlayBox.left < -2 || overlayBox.right > width + 2 || overlayBox.top < -2 || overlayBox.bottom > height + 2) {
      throw new Error(`phone inbox filter overlay is outside the left lane: ${JSON.stringify({ left: overlayBox.left, right: overlayBox.right, top: overlayBox.top, bottom: overlayBox.bottom, width, height })}`)
    }
    const seededChat = ed.getShape(chat.id)
    const initialFilter = JSON.stringify(seededChat?.props?.filter || [])
    if (initialFilter === '[]') throw new Error('phone inbox filter test failed to seed sibling chat filter')
    const allPreset = overlay.querySelector('.fleet-filter-preset[data-preset="all"]')
    if (!(allPreset instanceof HTMLElement)) throw new Error('phone inbox filter overlay has no All preset')
    allPreset.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
    await new Promise(r => setTimeout(r, 250))
    const updatedChat = ed.getShape(chat.id)
    if (!updatedChat) throw new Error('phone chat disappeared after inbox filter edit')
    const updatedFilter = JSON.stringify(updatedChat.props?.filter || [])
    if (updatedFilter !== '[]') {
      throw new Error(`phone inbox filter preset did not update sibling chat filter: before=${initialFilter} after=${updatedFilter}`)
    }

    const touchProbe = document.createElement('div')
    touchProbe.className = 'fleet-chat-shape'
    touchProbe.style.cssText = 'position:absolute;left:-10000px;top:-10000px;width:320px;height:200px;'
    touchProbe.innerHTML = [
      '<div class="fleet-chat-log">',
      '<div class="chat-activity-card"><span class="drag-handle"></span>activity</div>',
      '<div class="code-block-header">code</div>',
      '<div class="tlda-card">doc card</div>',
      '</div>',
    ].join('')
    document.body.appendChild(touchProbe)
    const chatLog = touchProbe.querySelector('.fleet-chat-log')
    if (!(chatLog instanceof HTMLElement)) throw new Error('phone chat touch fixture did not render')
    const touchStyles = {
      chatLog: window.getComputedStyle(chatLog).touchAction,
      activityCard: window.getComputedStyle(touchProbe.querySelector('.chat-activity-card')).touchAction,
      codeHeader: window.getComputedStyle(touchProbe.querySelector('.code-block-header')).touchAction,
      tldaCard: window.getComputedStyle(touchProbe.querySelector('.tlda-card')).touchAction,
      dragHandle: window.getComputedStyle(touchProbe.querySelector('.drag-handle')).touchAction,
    }
    touchProbe.remove()
    if (touchStyles.chatLog === 'none') throw new Error(`chat scroller blocks touch scroll: ${JSON.stringify(touchStyles)}`)
    for (const key of ['activityCard', 'codeHeader', 'tldaCard']) {
      if (touchStyles[key] === 'none') throw new Error(`chat ${key} blocks touch scroll: ${JSON.stringify(touchStyles)}`)
    }
    if (touchStyles.dragHandle !== 'none') throw new Error(`drag handle should still own touch drag: ${JSON.stringify(touchStyles)}`)

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
      inbox: { w: inbox.props.w, h: inbox.props.h },
      chat: { w: chat.props.w, h: chat.props.h },
      column: { w: column.w, h: column.h },
      inboxFilter: {
        opened: true,
        before: initialFilter,
        after: updatedFilter,
      },
      layout: { w: layoutW, h: chat.props.h },
      lanes: {
        agentsInbox: { docLeftScreen: laneStops.agentsInbox },
        chat: { docLeftScreen: laneStops.chat },
        document: { docLeftScreen: laneStops.document },
      },
      screenChat: {
        x: Math.round(screenChat.x),
        y: Math.round(screenChat.y),
        w: Math.round(screenChat.w),
        h: Math.round(screenChat.h),
      },
      hudChatBox: {
        x: Math.round(chatBox.x),
        y: Math.round(chatBox.y),
        w: Math.round(chatBox.width),
        h: Math.round(chatBox.height),
      },
      textarea: {
        x: Math.round(taBox.x),
        y: Math.round(taBox.y),
        w: Math.round(taBox.width),
        h: Math.round(taBox.height),
      },
      extraPanels: fleet.filter(s => s.type !== 'fleet-agents' && s.type !== 'fleet-inbox' && s.type !== 'fleet-chat').map(s => s.type),
      touchStyles,
    }
  })

  await page.evaluate(() => {
    const ed = window.__tldraw_editor__
    const setup = window.__phoneLayoutExpected
    if (!ed || !setup) return
    const ids = ed.getCurrentPageShapes()
      .filter(s => s.props?.userId === setup.humanId && s.props?.deviceId === setup.myDeviceId)
      .map(s => s.id)
    if (setup.alienId) ids.push(setup.alienId)
    const anchorId = `shape:fleet-hud-anchor--${String(setup.humanId).replace('fleet:', '')}--${setup.myDeviceId}`
    if (ed.getShape(anchorId)) ids.push(anchorId)
    const unique = [...new Set(ids)].filter(id => ed.getShape(id))
    if (unique.length > 0) ed.store.remove(unique)
  })

  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch(err => {
  console.error(`phone-layout-mobile failed: ${err.message}`)
  process.exit(1)
})
