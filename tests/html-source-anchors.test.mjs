import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

let htmlSourceLineAnchorAtCanvasY
let htmlSourceLineCanvasPosition
let htmlIframeElements

async function loadModules() {
  if (htmlSourceLineAnchorAtCanvasY) return
  global.window = { __TLDA_CONFIG__: { store: { http: 'http://localhost' }, database: { http: 'http://localhost' } } }
  ;({
    htmlSourceLineAnchorAtCanvasY,
    htmlSourceLineCanvasPosition,
  } = await import('../src/htmlSourceAnchors.ts'))
  ;({ htmlIframeElements } = await import('../src/htmlIframeRegistry.ts'))
}

function installIframe(shapeId, html) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  global.window = dom.window
  global.document = dom.window.document

  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  iframe.contentDocument.body.innerHTML = html
  htmlIframeElements.set(shapeId, iframe)
  return iframe
}

function setOffsetTop(el, top) {
  Object.defineProperty(el, 'offsetTop', { value: top, configurable: true })
}

test('htmlSourceLineAnchorAtCanvasY maps canvas y to nearest markdown line anchor', async () => {
  await loadModules()
  const shapeId = 'shape:md-page-1'
  const iframe = installIframe(shapeId, '<p id="line-10">A</p><p id="line-20">B</p>')
  setOffsetTop(iframe.contentDocument.getElementById('line-10'), 100)
  setOffsetTop(iframe.contentDocument.getElementById('line-20'), 220)

  const anchor = htmlSourceLineAnchorAtCanvasY(
    { id: shapeId, props: { h: 400, source: './notes.md' } },
    { y: 0, h: 400 },
    230,
  )

  assert.deepEqual(anchor, {
    anchored: true,
    file: 'notes.md',
    line: 20,
    page: 0,
    shapeId,
  })
  htmlIframeElements.clear()
})

test('htmlSourceLineCanvasPosition reports missing-line-anchor without fabricating remap position', async () => {
  await loadModules()
  const shapeId = 'shape:md-page-1'
  installIframe(shapeId, '<p id="line-10">A</p>')

  const resolved = htmlSourceLineCanvasPosition(
    { id: shapeId, props: { h: 400, source: 'notes.md' } },
    { y: 50, h: 400 },
    20,
  )

  assert.deepEqual(resolved, {
    anchored: false,
    reason: 'missing-line-anchor',
    file: 'notes.md',
    page: 0,
    shapeId,
  })
  htmlIframeElements.clear()
})

test('htmlSourceLineCanvasPosition maps markdown line anchor back to canvas y', async () => {
  await loadModules()
  const shapeId = 'shape:md-page-1'
  const iframe = installIframe(shapeId, '<p id="line-20">B</p>')
  setOffsetTop(iframe.contentDocument.getElementById('line-20'), 220)

  const resolved = htmlSourceLineCanvasPosition(
    { id: shapeId, props: { h: 400, source: 'notes.md' } },
    { y: 50, h: 400 },
    20,
  )

  assert.deepEqual(resolved, {
    anchored: true,
    file: 'notes.md',
    line: 20,
    page: 0,
    shapeId,
    canvasY: 270,
  })
  htmlIframeElements.clear()
})
