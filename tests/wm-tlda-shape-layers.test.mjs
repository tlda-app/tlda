import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// The tlda resolver reads fleet identity, and src/fleet/fleet-data.mjs refuses
// to load without the config the server injects — "no fallback by design". So
// the module graph needs a document before it will import at all. Same setup as
// tests/fleet-chat-hud-hidden-render.test.mjs.
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
window.__TLDA_CONFIG__ = {
  name: 'test',
  database: { http: 'http://localhost/fleet', ws: 'ws://localhost/fleet' },
  store: { http: 'http://localhost/store', ws: 'ws://localhost/store' },
  licenseKey: '',
}

// fleet-data starts pollers on import. Track them so the run can exit; the
// neighbouring HUD test does the same for the same reason.
const intervals = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, delay, ...args) => {
  const handle = realSetInterval(fn, delay, ...args)
  intervals.push(handle)
  return handle
}

const {
  getEditorWMCore,
  getRegisteredViewportLayer,
  registerViewportLayer,
  unregisterViewportLayer,
  viewportCoordinateLayerId,
  viewportFrameLayerId,
} = await import('../src/wm/editor-wm.ts')
const { installTldaShapeLayers, tldaShapeLayerId } = await import('../src/wm/tlda-shape-layers.ts')
const { FLEET_HUD_VIEWPORT_ID } = await import('../src/wm/fleet-hud-layer.ts')

// AGENTS.md §"Prove the wire, not the two ends": calling the resolver and the
// core from one test proves both functions and nothing about whether the
// install actually reaches the core every other WM consumer reads.
//
// So these go through the real modules. `installTldaShapeLayers` is called the
// way SvgDocument's onMount calls it, and every assertion afterwards asks
// `getEditorWMCore(editor)` — the same lookup FleetHUD and CanvasClipPanel use —
// rather than the core the install returned. Only tldraw's Editor is a stand-in.

function stubEditor(shapes = []) {
  return {
    // tldraw's own arithmetic, so a layer backed by this editor converts the way
    // the real one does. camera z of 1 at the origin keeps the numbers readable;
    // the conversion itself is exercised in wm-cross-viewport-spike.
    pageToScreen: (p) => ({ x: p.x + 1000, y: p.y + 500 }),
    screenToPage: (p) => ({ x: p.x - 1000, y: p.y - 500 }),
    getCurrentPageShapes: () => shapes,
  }
}

// Registering the HUD viewport the way CanvasClipPanel does: two layers on the
// surface's core, then a registration keyed by viewport id.
function registerHudViewport(editor) {
  const wm = getEditorWMCore(editor)
  const frameLayerId = viewportFrameLayerId(FLEET_HUD_VIEWPORT_ID)
  const coordinateLayerId = viewportCoordinateLayerId(FLEET_HUD_VIEWPORT_ID)
  wm.defineOrUpdateLayer(frameLayerId, {
    parent: wm.rootLayerId,
    policy: { x: 'pin', y: 'pin', zoom: 'lock' },
  })
  wm.defineOrUpdateLayer(coordinateLayerId, {
    parent: frameLayerId,
    transform: { x: 0, y: 0, scale: 1 },
  })
  const registration = { viewportId: FLEET_HUD_VIEWPORT_ID, wm, frameLayerId, coordinateLayerId }
  registerViewportLayer(editor, registration)
  return () => unregisterViewportLayer(editor, FLEET_HUD_VIEWPORT_ID, registration)
}

test('the install reaches the core every other consumer reads', () => {
  const editor = stubEditor()
  installTldaShapeLayers(editor)

  // Not the core the install returned — the one FleetHUD would look up.
  const wm = getEditorWMCore(editor)
  assert.equal(wm.layerIdOfShape({ type: 'draw' }), 'document-page')
  assert.ok(wm.layerIds().includes('fleet-overlay'), 'the HUD layers are defined at mount')
  assert.ok(wm.layerIds().includes('document-page'))
})

test('document-page is backed by the editor, so page coordinates project through it', () => {
  const editor = stubEditor()
  installTldaShapeLayers(editor)
  const wm = getEditorWMCore(editor)

  // A shape at page (10, 20) is at screen (1010, 520) under this editor. If
  // document-page were a bare frame instead of a page-backed layer, this would
  // be (10, 20) and every screen-space consumer would be quietly wrong.
  const onScreen = wm.shapeExtentIn({ type: 'draw' }, { x: 10, y: 20 }, wm.rootLayerId)
  assert.deepEqual({ x: onScreen.x, y: onScreen.y }, { x: 1010, y: 520 })
})

test('a managed surface is in the layer its own record names', () => {
  const editor = stubEditor()
  const wm = installTldaShapeLayers(editor)
  wm.defineOrUpdateLayer('managed:annotation-viewer', { parent: wm.rootLayerId })

  const surface = { type: 'geo', meta: { managedLayerId: 'managed:annotation-viewer' } }
  assert.equal(wm.layerIdOfShape(surface), 'managed:annotation-viewer')
})

test('a managed layer this core never defined is not claimed', () => {
  const editor = stubEditor()
  const wm = installTldaShapeLayers(editor)
  // The meta names a layer, but nothing defined it — a surface that was closed,
  // or a record from another room. Claiming it would hand callers a layer id
  // that every translate throws on.
  const stale = { type: 'geo', meta: { managedLayerId: 'managed:long-gone' } }
  assert.equal(wm.layerIdOfShape(stale), wm.rootLayerId)
})

test('membership follows the projection: it moves when the HUD viewport registers', () => {
  const editor = stubEditor()
  installTldaShapeLayers(editor)
  const wm = getEditorWMCore(editor)
  const coordinateLayerId = viewportCoordinateLayerId(FLEET_HUD_VIEWPORT_ID)

  // isMyFleetShape needs a live browser identity, which node has not got, so it
  // is false here and the fleet branch cannot be reached through it. What this
  // asserts instead is the half that is this module's own: given the HUD
  // viewport is registered, the resolver reads the registry rather than a
  // constant, and reads it live.
  assert.equal(getRegisteredViewportLayer(editor, FLEET_HUD_VIEWPORT_ID), undefined)

  const unregister = registerHudViewport(editor)
  assert.equal(getRegisteredViewportLayer(editor, FLEET_HUD_VIEWPORT_ID)?.coordinateLayerId, coordinateLayerId)
  assert.ok(wm.layerIds().includes(coordinateLayerId))

  unregister()
  // With the HUD gone the panels are back on the main canvas, and document-page
  // is where they are. Membership is not sticky.
  assert.equal(getRegisteredViewportLayer(editor, FLEET_HUD_VIEWPORT_ID), undefined)
  assert.equal(tldaShapeLayerId(editor, { type: 'draw' }), 'document-page')
})

test('the readout groups the page by layer', () => {
  const shapes = [
    { id: 'shape:a', type: 'draw' },
    { id: 'shape:b', type: 'draw' },
    { id: 'shape:c', type: 'geo', meta: { managedLayerId: 'managed:lightbox' } },
  ]
  const editor = stubEditor(shapes)
  const wm = installTldaShapeLayers(editor)
  wm.defineOrUpdateLayer('managed:lightbox', { parent: wm.rootLayerId })

  const report = globalThis.window?.__tlda_wm_core__?.shapeLayerReport?.()
  assert.ok(report, 'the readout is published on __tlda_wm_core__')
  assert.equal(report.byLayer['document-page'].count, 2)
  assert.deepEqual(report.byLayer['document-page'].types, { draw: 2 })
  assert.equal(report.byLayer['managed:lightbox'].count, 1)
  assert.equal(report.hudProjecting, false)
})

// Last, and required: fleet-data's pollers and JSDOM's own timers outlive the
// assertions, and bin/run-test-suite.mjs SIGTERMs a file that does not exit —
// which reports as a failure rather than as a hang, so it has to be cleaned up
// here rather than left to the runner.
test('teardown', () => {
  for (const handle of intervals) clearInterval(handle)
  dom.window.close()
})
