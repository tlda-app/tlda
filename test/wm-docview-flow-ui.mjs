#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRwToken, getServerUrl } from '../shared/config.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TLDA_DEV = join(ROOT, 'cli', 'tlda-dev.mjs')

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=')
      return [k, v.join('=') || true]
    }),
)

const BASE = String(args.url || getServerUrl()).replace(/\/+$/, '')
const DOC = String(args.doc || 'synth-supplement')
const RUN_ID = Date.now().toString(36)
const NAME = String(args.name || `wm-flow-${RUN_ID}`)
const PW_AS = process.env.TLDA_PW_AS || `fleet:${NAME}`
const TOKEN = String(args.token || getRwToken() || '')
const URL = `${BASE}/?doc=${encodeURIComponent(DOC)}&name=${encodeURIComponent(NAME)}&pw=1&fleetLayout=3col&wmFlowGate=${RUN_ID}${TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''}`

function runPw(verb, ...verbArgs) {
  const out = execFileSync(process.execPath, [TLDA_DEV, 'pw', verb, ...verbArgs], {
    cwd: ROOT,
    env: { ...process.env, TLDA_PW_AS: PW_AS },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  if (out.includes('### Error')) {
    throw new Error(`tlda-dev pw ${verb} failed:\n${out}`)
  }
  return out
}

function gotoPw(url) {
  const out = execFileSync(process.execPath, [TLDA_DEV, 'pw', 'goto', url], {
    cwd: ROOT,
    env: { ...process.env, TLDA_PW_AS: PW_AS },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  if (out.includes('### Error') && !out.includes('TimeoutError: Timeout') && !out.includes('waiting until "domcontentloaded"')) {
    throw new Error(`tlda-dev pw goto failed:\n${out}`)
  }
  return out
}

function evalPw(source) {
  const out = runPw('eval', source)
  const match = out.match(/### Result\n([\s\S]*?)\n### Ran Playwright code/)
  if (!match) throw new Error(`could not parse tlda-dev pw eval output:\n${out}`)
  return JSON.parse(match[1])
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const readScript = String.raw`() => {
  const editor = window.editor || window.__tldraw_editor__
  const identity = localStorage.getItem('tlda-identity') || ''
  const userId = identity.startsWith('fleet:') ? identity : 'fleet:' + identity
  const deviceId = localStorage.getItem('tlda-device-id') || ''
  const registry = window.__tlda_wm_docviews__ || {}
  const mine = editor?.getCurrentPageShapes?.()
    .filter(s => String(s.type).startsWith('fleet-') && s.props?.userId === userId && s.props?.deviceId === deviceId) || []
  const docview = mine.find(s => s.type === 'fleet-docview') || null
  const registryState = docview ? registry[docview.id] || null : null
  const docviewKey = docview ? String(docview.id).replace(/^shape:/, '') : ''
  const host = docviewKey
    ? [...document.querySelectorAll('[data-wm-surface-id^="fleet-docview:"]')]
        .find(el => (el.getAttribute('data-wm-surface-id') || '').includes(docviewKey)) || null
    : null
  const state = registryState || (host ? {
    surfaceId: host.getAttribute('data-wm-surface-id') || '',
    layerId: host.getAttribute('data-wm-layer-id') || '',
    viewportId: host.getAttribute('data-viewport-id') || '',
  } : null)
  let viewport = null
  let viewportError = null
  if (state && editor) {
    try {
      const vp = editor.getViewport(state.viewportId)
      viewport = vp ? { id: vp.id, camera: vp.camera, screenBounds: vp.screenBounds } : null
    } catch (error) {
      viewportError = error instanceof Error ? error.message : String(error)
    }
  }
  const hudState = window.__tlda_wm_hud__ || null
  const hudHost = document.querySelector('[data-viewport-id="wm:fleet-hud"]')
  const anchor = [...document.querySelectorAll('[data-anchor]')]
    .find(el => !el.closest('.fleet-hud-wrap')) || document.querySelector('[data-anchor]')
  const anchorRect = anchor?.getBoundingClientRect?.()
  const hostRect = host?.getBoundingClientRect?.()
  const visibleHost = hostRect ? {
    left: Math.max(0, hostRect.left),
    top: Math.max(0, hostRect.top),
    right: Math.min(window.innerWidth, hostRect.right),
    bottom: Math.min(window.innerHeight, hostRect.bottom),
  } : null
  const docviewWheelPoint = visibleHost && visibleHost.right > visibleHost.left && visibleHost.bottom > visibleHost.top
    ? { x: (visibleHost.left + visibleHost.right) / 2, y: (visibleHost.top + visibleHost.bottom) / 2 }
    : null
  return {
    userId,
    deviceId,
    fleetCount: mine.length,
    types: mine.map(s => s.type).sort(),
    docview: docview ? { id: docview.id, props: docview.props, bounds: editor.getShapePageBounds(docview.id) } : null,
    state,
    registryState,
    host: host ? host.getBoundingClientRect().toJSON() : null,
    docviewWheelPoint,
    viewport,
    viewportError,
    hudState,
    hudHost: hudHost ? hudHost.getBoundingClientRect().toJSON() : null,
    camera: editor?.getCamera?.(),
    docWheelPoint: anchorRect ? { x: anchorRect.left + anchorRect.width / 2, y: anchorRect.top + anchorRect.height / 2 } : null,
    anchor: anchorRect ? {
      x: anchorRect.left + anchorRect.width / 2,
      y: anchorRect.top + anchorRect.height / 2,
      anchor: anchor.getAttribute('data-anchor'),
      title: anchor.getAttribute('data-title') || '',
    } : null,
  }
}`

const cleanupScript = String.raw`() => {
  const editor = window.editor || window.__tldraw_editor__
  const identity = localStorage.getItem('tlda-identity') || ''
  const userId = identity.startsWith('fleet:') ? identity : 'fleet:' + identity
  const deviceId = localStorage.getItem('tlda-device-id') || ''
  const mine = editor?.getCurrentPageShapes?.()
    .filter(s => String(s.type).startsWith('fleet-') && s.props?.userId === userId && s.props?.deviceId === deviceId)
    .map(s => s.id) || []
  if (mine.length) editor.store.remove(mine)
  return { removed: mine.length, userId, deviceId }
}`

async function waitFor(predicate, label, timeout = 90000) {
  const until = Date.now() + timeout
  let last = null
  while (Date.now() < until) {
    last = evalPw(readScript)
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`)
}

async function main() {
  console.log(`wm-docview-flow-ui doc=${DOC} url=${URL}`)
  gotoPw(URL)
  try {
    await waitFor(snap => snap.docview && snap.state && snap.host && snap.viewport && snap.hudState && snap.hudHost, 'fleet layout docview wm surface')
    const beforeRef = evalPw(readScript)
    assert(beforeRef.fleetCount >= 3, `fleet layout did not create enough owned shapes: ${JSON.stringify(beforeRef)}`)
    assert(beforeRef.types.includes('fleet-docview'), `fleet layout did not create docview: ${JSON.stringify(beforeRef.types)}`)
    assert(beforeRef.anchor, 'no SVG data-anchor found for real ref-click flow')

    runPw('mousemove', String(Math.round(beforeRef.anchor.x)), String(Math.round(beforeRef.anchor.y)))
    runPw('mousedown')
    runPw('mouseup')
    const afterRef = await waitFor(snap =>
      snap.docview?.props?.page > 0 &&
      (snap.docview.props.label !== beforeRef.docview.props.label ||
       snap.docview.props.title !== beforeRef.docview.props.title ||
       snap.docview.props.yTop !== beforeRef.docview.props.yTop),
      'real ref click docview update',
    )
    assert(afterRef.state?.surfaceId?.startsWith('fleet-docview:'), `missing WM docview state after ref click: ${JSON.stringify(afterRef)}`)
    assert(afterRef.docview.props.title || afterRef.docview.props.label, `ref click did not update docview title/label: ${JSON.stringify(afterRef.docview.props)}`)

    assert(afterRef.docviewWheelPoint, `layout-created docview has no visible wheel target: ${JSON.stringify(afterRef.host)}`)
    runPw('mousemove', String(Math.round(afterRef.docviewWheelPoint.x)), String(Math.round(afterRef.docviewWheelPoint.y)))
    runPw('mousewheel', '0', '120')
    await new Promise(resolve => setTimeout(resolve, 350))
    const afterWheel = evalPw(readScript)
    assert(
      afterWheel.viewport.camera.y !== afterRef.viewport.camera.y,
      `real wheel did not pan layout-created docview viewport: ${JSON.stringify({ before: afterRef.viewport, after: afterWheel.viewport })}`,
    )

    assert(afterWheel.docWheelPoint, `missing document wheel point: ${JSON.stringify(afterWheel)}`)
    runPw('mousemove', String(Math.round(afterWheel.docWheelPoint.x)), String(Math.round(afterWheel.docWheelPoint.y)))
    runPw('mousewheel', '0', '240')
    await new Promise(resolve => setTimeout(resolve, 500))
    const afterMainCamera = evalPw(readScript)
    assert(
      afterMainCamera.camera.x !== afterWheel.camera.x ||
      afterMainCamera.camera.y !== afterWheel.camera.y ||
      afterMainCamera.camera.z !== afterWheel.camera.z,
      `real document wheel did not move main camera: ${JSON.stringify({ before: afterWheel.camera, after: afterMainCamera.camera })}`,
    )
    assert(afterMainCamera.hudState?.viewportId === 'wm:fleet-hud', `HUD WM state missing after main camera move: ${JSON.stringify(afterMainCamera.hudState)}`)
    assert(afterMainCamera.hudHost?.width > 0 && afterMainCamera.hudHost?.height > 0, `HUD viewport host disappeared: ${JSON.stringify(afterMainCamera.hudHost)}`)
    assert(afterMainCamera.host?.width > 0 && afterMainCamera.host?.height > 0, `docview host disappeared after main camera move: ${JSON.stringify(afterMainCamera.host)}`)
  } finally {
    const result = evalPw(cleanupScript)
    console.log(`cleanup removed=${result.removed} owner=${result.userId}|${result.deviceId}`)
  }
  console.log('wm-docview-flow-ui passed')
}

main().catch(err => {
  console.error(`wm-docview-flow-ui failed: ${err.message}`)
  process.exit(1)
})
