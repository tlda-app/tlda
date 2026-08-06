import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { annotationViewerCanvasOwnsEvent } from '../src/overlays/annotation-viewer-event-ownership.ts'

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
  assert.equal(annotationViewerCanvasOwnsEvent('hovering', canvas), false)
  assert.equal(annotationViewerCanvasOwnsEvent('pinned', canvas), true)
  assert.equal(annotationViewerCanvasOwnsEvent('navigated', canvas), true)
  assert.equal(annotationViewerCanvasOwnsEvent('pinned', nav), false)
})

test('viewer capture handlers pin previews and yield pinned canvases', () => {
  const source = readFileSync(new URL('../src/overlays/AnnotationViewer.tsx', import.meta.url), 'utf8')
  assert.match(source, /state === 'hovering'.*clickStartRef\.current = \{ x: e\.clientX, y: e\.clientY \}/s)
  assert.match(source, /Math\.sqrt\(dx \* dx \+ dy \* dy\) < 5\) setState\('pinned'\)/)
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
  assert.match(handleGo, /activateSpatialDocument/)
  assert.match(enterView, /activateSpatialDocument/)
})
