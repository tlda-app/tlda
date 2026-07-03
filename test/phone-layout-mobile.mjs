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
const AUTO = String(args.auto || '') === '1'
const ROTATE_WIDTH = Number(args.rotateWidth || 0)
const ROTATE_HEIGHT = Number(args.rotateHeight || 0)

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
  console.log(`phone-layout-mobile url=${URL} viewport=${WIDTH}x${HEIGHT} clip=${CLIP ? '1' : '0'} auto=${AUTO ? '1' : '0'}`)
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

  await page.evaluate(async ({ width, height, clip, qaId, auto }) => {
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
      auto,
    }
  }, { width: WIDTH, height: HEIGHT, clip: CLIP, qaId: QA_ID, auto: AUTO })

  if (!AUTO) {
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
  }
  await page.waitForFunction(() => !!window.__tldraw_hud_editor__, null, { timeout: 10000 })
  await page.waitForFunction(() => !!document.querySelector('.fleet-hud-wrap .fleet-inbox-shape'), null, { timeout: 10000 })
  await page.waitForTimeout(500)

  let report = await page.evaluate(async () => {
    const ed = window.__tldraw_editor__
    const setup = window.__phoneLayoutExpected
    if (!setup) throw new Error('phone layout setup missing')
    const { width, height, clip, pb, docScreen, clippedDocScreen, cameraZ, humanId, myDeviceId, alienId } = setup

    const fleet = ed.getCurrentPageShapes().filter(s =>
      ['fleet-agents', 'fleet-inbox', 'fleet-chat', 'fleet-docview', 'fleet-search', 'fleet-touch-inbox'].includes(s.type) &&
      s.props?.userId === humanId &&
      s.props?.deviceId === myDeviceId,
    )
    const inbox = fleet.find(s => s.type === 'fleet-inbox')
    const unexpected = fleet.filter(s => s.type !== 'fleet-inbox')
    if (!inbox) {
      throw new Error(`missing phone layout shapes: ${fleet.map(s => s.type).join(',')}`)
    }
    if (unexpected.length > 0) {
      throw new Error(`phone layout should only create the inbox pane shape, got: ${fleet.map(s => s.type).join(',')}`)
    }
    if (!inbox.isLocked) {
      throw new Error('phone inbox pane should be locked/fixed')
    }

    const expectedW = width
    const expectedH = height
    if (Math.abs(inbox.props.w - expectedW) > 1) {
      throw new Error(`inbox width ${inbox.props.w} != expected screen width ${expectedW}`)
    }
    if (Math.abs(inbox.props.h - expectedH) > 1) {
      throw new Error(`inbox height ${inbox.props.h} != expected screen height ${expectedH}`)
    }
    const ownerKey = `${humanId}|${myDeviceId}`
    let ownerHash = 0
    for (let i = 0; i < ownerKey.length; i++) ownerHash = ((ownerHash << 5) - ownerHash + ownerKey.charCodeAt(i)) | 0
    const layoutDx = -(Math.abs(ownerHash) % 16) * 4000
    if (Math.abs((inbox.x + inbox.props.w) - (pb.x + layoutDx)) > 1) {
      throw new Error(`document pane is not immediately to the right of inbox pane after layout dx: inboxRight=${inbox.x + inbox.props.w} docLeftPlusDx=${pb.x + layoutDx}`)
    }
    const visibleHudIds = Array.from(document.querySelectorAll('.fleet-hud-wrap [data-shape-id]'))
      .map(el => el.getAttribute('data-shape-id'))
      .filter(Boolean)
    if (visibleHudIds.includes(alienId)) {
      throw new Error(`HUD rendered same-user other-device fleet shape: ${alienId}`)
    }

    const laneStops = {
      document: 0,
      inbox: width,
    }
    const cam = ed.getCamera()
    ed.setCamera({ ...cam, x: laneStops.inbox / cam.z - pb.x }, { animation: { duration: 0 } })
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
    const footer = inboxEl.querySelector('.fleet-inbox-phone-footer')
    const littleChat = inboxEl.querySelector('.fleet-inbox-phone-composer')
    const phoneAgents = inboxEl.querySelector('.fleet-inbox-phone-agents')
    if (!(footer instanceof HTMLElement) || !(littleChat instanceof HTMLElement) || !(phoneAgents instanceof HTMLElement)) {
      throw new Error('phone inbox footer/little-chat/agents sub-layout did not render')
    }
    const footerBox = footer.getBoundingClientRect()
    const littleChatBox = littleChat.getBoundingClientRect()
    const phoneAgentsBox = phoneAgents.getBoundingClientRect()
    if (footerBox.left < inboxBox.left - 1 || footerBox.right > inboxBox.right + 1 || footerBox.bottom > inboxBox.bottom + 1) {
      throw new Error(`phone footer is not inside inbox pane: ${JSON.stringify({ footer: footerBox.toJSON?.() || footerBox, inbox: inboxBox.toJSON?.() || inboxBox })}`)
    }
    const portrait = height >= width
    if (portrait) {
      if (littleChatBox.bottom > phoneAgentsBox.top + 2) {
        throw new Error(`portrait phone footer should stack little chat above agents: ${JSON.stringify({ littleChat: littleChatBox.toJSON?.() || littleChatBox, agents: phoneAgentsBox.toJSON?.() || phoneAgentsBox })}`)
      }
    } else {
      if (littleChatBox.right > phoneAgentsBox.left + 2 || phoneAgentsBox.width <= littleChatBox.width) {
        throw new Error(`landscape phone footer should put little chat left of wider agents: ${JSON.stringify({ littleChat: littleChatBox.toJSON?.() || littleChatBox, agents: phoneAgentsBox.toJSON?.() || phoneAgentsBox })}`)
      }
    }

    const stopErrors = []
    for (const [name, stop] of Object.entries(laneStops)) {
      ed.setCamera({ ...ed.getCamera(), x: stop / ed.getCamera().z - pb.x }, { animation: { duration: 0 } })
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const actual = (pb.x + ed.getCamera().x) * ed.getCamera().z
      if (Math.abs(actual - stop) > 0.01) {
        stopErrors.push(`${name}: expected ${stop}, got ${actual}`)
      }
    }
    if (stopErrors.length > 0) {
      throw new Error(`phone pane stops are not exact screen-width multiples: ${stopErrors.join('; ')}`)
    }
    for (let i = 0; i < 12; i++) {
      const stop = i % 2 === 0 ? laneStops.inbox : laneStops.document
      ed.setCamera({ ...ed.getCamera(), x: stop / ed.getCamera().z - pb.x }, { animation: { duration: 0 } })
      await new Promise(r => requestAnimationFrame(r))
      const actual = (pb.x + ed.getCamera().x) * ed.getCamera().z
      if (Math.abs(actual - stop) > 0.01) {
        throw new Error(`rapid phone pane paging drifted on iteration ${i}: expected ${stop}, got ${actual}`)
      }
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
      control: setup.auto ? { urlAuto: true } : { pill: 'tapped', preset: 'tapped' },
      panes: {
        inbox: { w: inbox.props.w, h: inbox.props.h, locked: inbox.isLocked },
        document: { docLeftScreen: laneStops.document },
        inboxStop: { docLeftScreen: laneStops.inbox },
        layoutDx,
      },
      hudInboxBox: {
        x: Math.round(inboxBox.x),
        y: Math.round(inboxBox.y),
        w: Math.round(inboxBox.width),
        h: Math.round(inboxBox.height),
      },
      extraPanels: unexpected.map(s => s.type),
      phoneFooter: {
        mode: portrait ? 'portrait' : 'landscape',
        footer: {
          x: Math.round(footerBox.x),
          y: Math.round(footerBox.y),
          w: Math.round(footerBox.width),
          h: Math.round(footerBox.height),
        },
        littleChat: {
          x: Math.round(littleChatBox.x),
          y: Math.round(littleChatBox.y),
          w: Math.round(littleChatBox.width),
          h: Math.round(littleChatBox.height),
        },
        agents: {
          x: Math.round(phoneAgentsBox.x),
          y: Math.round(phoneAgentsBox.y),
          w: Math.round(phoneAgentsBox.width),
          h: Math.round(phoneAgentsBox.height),
        },
      },
      touchStyles,
    }
  })

  if (ROTATE_WIDTH > 0 && ROTATE_HEIGHT > 0) {
    await page.setViewportSize({ width: ROTATE_WIDTH, height: ROTATE_HEIGHT })
    await page.waitForTimeout(900)
    report.rotated = await page.evaluate(async ({ width, height }) => {
      const ed = window.__tldraw_editor__
      const setup = window.__phoneLayoutExpected
      if (!ed || !setup) throw new Error('rotation setup missing')
      const fleet = ed.getCurrentPageShapes().filter(s =>
        ['fleet-inbox', 'fleet-chat'].includes(s.type) &&
        s.props?.userId === setup.humanId &&
        s.props?.deviceId === setup.myDeviceId,
      )
      const inbox = fleet.find(s => s.type === 'fleet-inbox')
      if (!inbox) throw new Error('missing phone inbox after rotation')
      if (Math.abs(inbox.props.w - width) > 1 || Math.abs(inbox.props.h - height) > 1) {
        throw new Error(`phone inbox did not refit after rotation: ${JSON.stringify({ got: inbox.props, expected: { width, height } })}`)
      }
      const pageShape = ed.getCurrentPageShapes().find(s => s.type === 'svg-page' || s.type === 'html-page')
      const pb = pageShape ? ed.getShapePageBounds(pageShape.id) : null
      if (!pb) throw new Error('missing page bounds after rotation')
      const cam = ed.getCamera()
      ed.setCamera({ ...cam, x: width / cam.z - pb.x }, { animation: { duration: 0 } })
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const inboxEl = document.querySelector(`.fleet-hud-wrap [data-shape-id="${inbox.id}"] .fleet-inbox-shape`)
        || document.querySelector(`.fleet-hud-wrap [data-shape-id="${inbox.id}"]`)
      if (!(inboxEl instanceof HTMLElement)) throw new Error('HUD did not render rotated phone inbox')
      const footer = inboxEl.querySelector('.fleet-inbox-phone-footer')
      const littleChat = inboxEl.querySelector('.fleet-inbox-phone-composer')
      const phoneAgents = inboxEl.querySelector('.fleet-inbox-phone-agents')
      if (!(footer instanceof HTMLElement) || !(littleChat instanceof HTMLElement) || !(phoneAgents instanceof HTMLElement)) {
        throw new Error('rotated phone footer/little-chat/agents sub-layout did not render')
      }
      const footerBox = footer.getBoundingClientRect()
      const littleChatBox = littleChat.getBoundingClientRect()
      const phoneAgentsBox = phoneAgents.getBoundingClientRect()
      if (footerBox.left < -1 || footerBox.right > width + 1 || footerBox.bottom > height + 1) {
        throw new Error(`rotated phone footer is not inside viewport: ${JSON.stringify({ footer: footerBox.toJSON?.() || footerBox, width, height })}`)
      }
      if (height >= width) {
        if (littleChatBox.bottom > phoneAgentsBox.top + 2) throw new Error('rotated portrait footer did not stack')
      } else if (littleChatBox.right > phoneAgentsBox.left + 2 || phoneAgentsBox.width <= littleChatBox.width) {
        throw new Error('rotated landscape footer did not put agents to the wider right side')
      }
      return {
        viewport: { w: width, h: height },
        inbox: { w: inbox.props.w, h: inbox.props.h, locked: inbox.isLocked },
        footer: {
          x: Math.round(footerBox.x),
          y: Math.round(footerBox.y),
          w: Math.round(footerBox.width),
          h: Math.round(footerBox.height),
        },
      }
    }, { width: ROTATE_WIDTH, height: ROTATE_HEIGHT })
  }

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
