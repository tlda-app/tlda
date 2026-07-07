import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import type { Editor } from 'tldraw'

type TldaConfigWindow = Window & typeof globalThis & {
  __TLDA_CONFIG__?: {
    name: string
    database: { http: string; ws: string }
    store: { http: string; ws: string }
    licenseKey: string
  }
}

type Shape = {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  meta?: Record<string, unknown>
}

function makeEditor(shapes: Shape[], viewport: { x: number; y: number; w: number; h: number }) {
  return {
    getCurrentPageShapes: () => shapes,
    getViewportPageBounds: () => viewport,
    getShapePageBounds: (id: string) => {
      const shape = shapes.find(s => s.id === id)
      return shape ? { x: shape.x, y: shape.y, w: shape.w, h: shape.h } : null
    },
  } as unknown as Editor
}

async function loadSubject() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://tlda.test/?doc=bregman' })
  const previousWindow = globalThis.window
  const previousLocalStorage = globalThis.localStorage
  globalThis.window = dom.window as unknown as TldaConfigWindow
  globalThis.localStorage = dom.window.localStorage
  globalThis.window.__TLDA_CONFIG__ = {
    name: 'test',
    database: { http: 'https://db.test', ws: 'wss://db.test' },
    store: { http: 'https://store.test', ws: 'wss://store.test' },
    licenseKey: '',
  }
  const mod = await import('../src/shapes/fleet-layout-context')
  return {
    getDocumentPageBounds: mod.getDocumentPageBounds,
    cleanup: () => {
      globalThis.window = previousWindow
      globalThis.localStorage = previousLocalStorage
      dom.window.close()
    },
  }
}

test('fleet layout bounds anchor to visible temporary markdown place', async () => {
  const { getDocumentPageBounds, cleanup } = await loadSubject()
  const editor = makeEditor([
    { id: 'shape:page-1', type: 'svg-page', x: 0, y: 0, w: 800, h: 1200 },
    {
      id: 'shape:fleet-markdown-chip-temp-column',
      type: 'html-page',
      x: 5000,
      y: 200,
      w: 800,
      h: 1200,
      meta: { temporaryMarkdownColumn: true },
    },
  ], { x: 5000, y: 200, w: 800, h: 800 })

  try {
    assert.deepEqual(getDocumentPageBounds(editor), {
      pageShapes: [editor.getCurrentPageShapes()[1]],
      minLeft: 5000,
      minTop: 200,
      maxRight: 5800,
    })
  } finally {
    cleanup()
  }
})

test('fleet layout bounds fall back to document pages when markdown place is not current', async () => {
  const { getDocumentPageBounds, cleanup } = await loadSubject()
  const editor = makeEditor([
    { id: 'shape:page-1', type: 'svg-page', x: 0, y: 0, w: 800, h: 1200 },
    {
      id: 'shape:fleet-markdown-chip-temp-column',
      type: 'html-page',
      x: 5000,
      y: 200,
      w: 800,
      h: 1200,
      meta: { temporaryMarkdownColumn: true },
    },
  ], { x: 0, y: 0, w: 800, h: 800 })

  try {
    const result = getDocumentPageBounds(editor)
    assert.equal(result?.pageShapes[0].id, 'shape:page-1')
    assert.equal(result?.minLeft, 0)
    assert.equal(result?.maxRight, 800)
  } finally {
    cleanup()
  }
})
