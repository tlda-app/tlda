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
const NAME = String(args.name || 'wm-docview-gate')
const RUN_ID = Date.now().toString(36)
const PW_AS = process.env.TLDA_PW_AS || `fleet:${NAME}`
const TOKEN = String(args.token || getRwToken() || '')

const URL = `${BASE}/?doc=${encodeURIComponent(DOC)}&name=${encodeURIComponent(NAME)}&pw=1&wmDocviewGate=${RUN_ID}${TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''}`

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

function evalPw(source) {
  const out = runPw('eval', source)
  const match = out.match(/### Result\n([\s\S]*?)\n### Ran Playwright code/)
  if (!match) throw new Error(`could not parse tlda-dev pw eval output:\n${out}`)
  return JSON.parse(match[1])
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const setupScript = String.raw`async () => {
  const waitFor = async (predicate, label, timeout = 60000) => {
    const until = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() > until) throw new Error(label + ' timed out')
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }

  await waitFor(() => !!(window.editor || window.__tldraw_editor__), 'editor')
  localStorage.setItem('fleet-hud-expanded', '1')
  localStorage.removeItem('fleet-hud-override')

  const editor = window.editor || window.__tldraw_editor__
  const identity = localStorage.getItem('tlda-identity') || 'wm-docview-gate'
  const userId = identity.startsWith('fleet:') ? identity : 'fleet:' + identity
  const deviceId = localStorage.getItem('tlda-device-id') || 'wm-docview-device'
  const shapeId = 'shape:wm-docview-gate-' + '__RUN_ID__'

  const stale = editor.getCurrentPageShapes()
    .map(s => s.id)
    .filter(id => id.startsWith('shape:wm-docview-gate-'))
  if (stale.length) {
    editor.store.remove(stale)
    await new Promise(resolve => setTimeout(resolve, 750))
  }

  editor.createShape({
    id: shapeId,
    type: 'fleet-docview',
    x: 320,
    y: -900,
    isLocked: false,
    props: {
      w: 420,
      h: 320,
      sources: JSON.stringify(['ref']),
      mode: 'manual',
      label: '',
      page: 1,
      yTop: 0,
      yBottom: 300,
      title: 'WM docview gate',
      userId,
      deviceId,
    },
  })
  editor.centerOnPoint({ x: 530, y: -740 }, { animation: { duration: 0 } })

  await waitFor(() => {
    const registry = window.__tlda_wm_docviews__ || {}
    const state = registry[shapeId]
    const host = state && document.querySelector('[data-wm-surface-id="' + state.surfaceId + '"]')
    return state && host && document.querySelector('[data-viewport-id="' + state.viewportId + '"]')
  }, 'wm docview surface')

  return { shapeId, userId, deviceId }
}`.replaceAll('__RUN_ID__', RUN_ID)

const readScript = String.raw`() => {
  const editor = window.editor || window.__tldraw_editor__
  const registry = window.__tlda_wm_docviews__ || {}
  const entries = Object.entries(registry)
  const entry = entries.find(([id]) => id.startsWith('shape:wm-docview-gate-'))
  const state = entry?.[1] || null
  const host = state ? document.querySelector('[data-wm-surface-id="' + state.surfaceId + '"]') : null
  const viewport = state ? document.querySelector('[data-viewport-id="' + state.viewportId + '"]') : null
  let registered = null
  let registeredError = null
  if (state && editor) {
    try {
      const vp = editor.getViewport(state.viewportId)
      registered = vp ? { id: vp.id, camera: vp.camera, screenBounds: vp.screenBounds } : null
    } catch (error) {
      registeredError = error instanceof Error ? error.message : String(error)
    }
  }
  return {
    prototypePanelCount: document.querySelectorAll('[data-testid="wm-prototype-panel"]').length,
    surfaceCount: entries.length,
    state,
    host: host ? host.getBoundingClientRect().toJSON() : null,
    viewport: !!viewport,
    registered,
    registeredError,
  }
}`

const cleanupScript = String.raw`() => {
  const editor = window.editor || window.__tldraw_editor__
  const stale = editor?.getCurrentPageShapes?.()
    .map(s => s.id)
    .filter(id => id.startsWith('shape:wm-docview-gate-')) || []
  if (stale.length) editor.store.remove(stale)
  return { removed: stale.length }
}`

function main() {
  console.log(`wm-docview-ui doc=${DOC} url=${URL}`)
  runPw('goto', URL)
  try {
    const setup = evalPw(setupScript)
    const initial = evalPw(readScript)

    assert(initial.prototypePanelCount === 0, `prototype panel should not render: ${initial.prototypePanelCount}`)
    assert(initial.state?.surfaceId?.startsWith('fleet-docview:'), `missing docview surface: ${JSON.stringify(initial.state)}`)
    assert(initial.state?.viewportId?.startsWith('wm:fleet-docview:'), `missing docview viewport: ${JSON.stringify(initial.state)}`)
    assert(initial.state?.owner?.userId === setup.userId, `wrong owner: ${JSON.stringify(initial.state?.owner)}`)
    assert(initial.host?.width >= 390 && initial.host?.height >= 250, `docview host too small: ${JSON.stringify(initial.host)}`)
    assert(initial.viewport, 'named docview viewport did not render')
    assert(initial.registered?.camera?.z > 0, `viewport camera missing: ${JSON.stringify(initial.registered)}`)

    const wheelPoint = {
      x: Math.round(initial.host.left + initial.host.width / 2),
      y: Math.round(initial.host.top + initial.host.height / 2),
    }
    runPw('mousemove', String(wheelPoint.x), String(wheelPoint.y))
    runPw('mousewheel', '0', '120')
    const wheel = evalPw(`async () => {
      await new Promise(resolve => setTimeout(resolve, 250))
      return { before: ${JSON.stringify(initial)}, after: (${readScript})() }
    }`)

    assert(
      wheel.after.registered.camera.y !== wheel.before.registered.camera.y,
      `wheel did not pan docview viewport: ${JSON.stringify(wheel)}`,
    )
  } finally {
    evalPw(cleanupScript)
  }

  console.log('wm-docview-ui passed')
}

try {
  main()
} catch (err) {
  console.error(`wm-docview-ui failed: ${err.message}`)
  process.exit(1)
}
