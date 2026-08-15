import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { annotationViewerCanvasOwnsEvent } from '../src/overlays/annotation-viewer-event-ownership.ts'
import { createAnnotationViewerSurfaceRequest } from '../src/wm/annotation-viewer-surface.ts'

function fixture() {
  const dom = new JSDOM(`
    <div class="annotation-viewer">
      <div class="annotation-viewer-canvas"><div class="tl-container"><div data-viewport-id="viewer"><div id="canvas" class="tl-canvas"></div></div></div></div>
      <button id="nav" class="annotation-viewer-nav-btn"></button>
    </div>
  `)
  globalThis.Element = dom.window.Element
  return {
    canvas: dom.window.document.getElementById('canvas'),
    nav: dom.window.document.getElementById('nav'),
  }
}

test('pinned annotation canvas owns pointer and wheel events', () => {
  const { canvas, nav } = fixture()
  assert.equal(annotationViewerCanvasOwnsEvent('preview-readonly', canvas), false)
  assert.equal(annotationViewerCanvasOwnsEvent('chrome-catches-content-pans', canvas), true)
  assert.equal(annotationViewerCanvasOwnsEvent('chrome-catches-content-pans', nav), false)
  assert.equal(annotationViewerCanvasOwnsEvent('modal-catches-all', canvas), false)
})

test('viewer capture handlers pin previews and yield pinned canvases', () => {
  const source = readFileSync(new URL('../src/overlays/AnnotationViewer.tsx', import.meta.url), 'utf8')
  assert.match(source, /state === 'hovering'.*clickStartRef\.current = \{ x: e\.clientX, y: e\.clientY \}/s)
  assert.match(source, /Math\.sqrt\(dx \* dx \+ dy \* dy\) < 5\) pinPreview\(\)/)
  assert.match(source, /hitPolicy: 'chrome-catches-content-pans'/)
  for (const handler of ['onPointerDownCapture', 'onPointerMoveCapture', 'onPointerUpCapture', 'onPointerCancelCapture']) {
    const start = source.indexOf(`${handler}={(e) => {`)
    assert.notEqual(start, -1)
    const body = source.slice(start, source.indexOf('}}', start))
    assert.ok(body.indexOf('if (shouldLetCanvasOwnEvent(e)) return') < body.indexOf('stopEventPropagation(e)'))
  }
  assert.match(source, /readOnly=\{state === 'hovering'\}/)
})

test('document traversal carries the fleet in both directions', () => {
  const source = readFileSync(new URL('../src/overlays/AnnotationViewer.tsx', import.meta.url), 'utf8')
  assert.match(source, /const sourceDocument = currentSpatialDocument\(mainEditor, spatialDocuments\)/)
  assert.match(source, /spatialDocumentId: sourceDocument\?\.id/)
  assert.match(source, /if \(sourceDocument && targetDocument\) \{\s+activateSpatialDocument\(mainEditor, sourceDocument, targetDocument, cam\)\s+\}/)
  const handleGo = source.slice(source.indexOf('const handleGo'), source.indexOf('// Restore a stored view'))
  const enterView = source.slice(source.indexOf('const enterView'), source.indexOf('// Go back'))
  assert.doesNotMatch(handleGo, /isPhoneViewportSurface/)
  assert.match(handleGo, /activateSpatialDocument/)
  assert.match(enterView, /activateSpatialDocument/)
})

test('annotation viewer has one layout and interaction path at every viewport width', () => {
  const source = readFileSync(new URL('../src/overlays/AnnotationViewer.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/overlays/AnnotationViewer.css', import.meta.url), 'utf8')
  const documentSource = readFileSync(new URL('../src/SvgDocument.tsx', import.meta.url), 'utf8')
  const appCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /phone/i)
  assert.doesNotMatch(css, /phone/i)
  assert.match(source, /setSize\(\{ w: request\.extent\.w, h: request\.extent\.h \}\)/)
  assert.match(source, /maxHeightFraction=\{0\.5\}/)
  assert.match(documentSource, /<div className="managed-surface-overlay-owner">\s*<AnnotationViewer/)
  assert.match(appCss, /\.managed-surface-overlay-owner\s*\{[^}]*z-index: var\(--tlda-z-top-control-popover\)/)

  const base = {
    surfaceKey: 'test',
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    chipRect: { left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 },
    owner: { userId: 'user', deviceId: 'device' },
  }
  assert.deepEqual(createAnnotationViewerSurfaceRequest({ ...base, viewport: { w: 1200, h: 800 } }).extent, {
    x: 10, y: 8, w: 650, h: 450,
  })
  assert.deepEqual(createAnnotationViewerSurfaceRequest({ ...base, viewport: { w: 390, h: 844 } }).extent, {
    x: 8, y: 8, w: 374, h: 450,
  })
})
