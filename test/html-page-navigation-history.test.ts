import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import type { Editor, TLPageId } from 'tldraw'

import {
  HTML_NAV_STATE_KEY,
  htmlNavigationLocationFromHistoryState,
  installHtmlNavigationHistory,
  recordHtmlNavigationEnd,
  recordHtmlNavigationStart,
} from '../src/html-page-navigation-history'

function makeEditor() {
  let pageId = 'page:one'
  let camera = { x: 1, y: 2, z: 1 }
  let setCurrentPageCalls = 0
  return {
    getCamera: () => camera,
    setCamera: (next: { x: number; y: number; z: number }) => { camera = next },
    getCurrentPageId: () => pageId,
    setCurrentPage: (next: TLPageId) => {
      setCurrentPageCalls += 1
      pageId = String(next)
    },
    getPages: () => [{ id: 'page:one' }, { id: 'page:two' }],
    read: () => ({ pageId, camera, setCurrentPageCalls }),
  } as unknown as Editor & { read: () => { pageId: string; camera: { x: number; y: number; z: number }; setCurrentPageCalls: number } }
}

test('html page navigation history restores camera without changing TLDraw page', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://tlda.test/?doc=world-md' })
  const previousWindow = globalThis.window
  const previousPopStateEvent = globalThis.PopStateEvent
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  globalThis.PopStateEvent = dom.window.PopStateEvent

  try {
    const editor = makeEditor()
    const dispose = installHtmlNavigationHistory(editor)
    recordHtmlNavigationStart(editor)

    const initialState = window.history.state
    assert.ok(initialState?.[HTML_NAV_STATE_KEY])
    assert.deepEqual(htmlNavigationLocationFromHistoryState(initialState), {
      camera: { x: 1, y: 2, z: 1 },
    })

    editor.setCamera({ x: 30, y: 40, z: 2 })
    recordHtmlNavigationEnd(editor)
    await new Promise(resolve => setTimeout(resolve, 5))

    assert.deepEqual(htmlNavigationLocationFromHistoryState(window.history.state), {
      camera: { x: 30, y: 40, z: 2 },
    })

    window.dispatchEvent(new PopStateEvent('popstate', { state: initialState }))
    assert.deepEqual(editor.read(), {
      pageId: 'page:one',
      camera: { x: 1, y: 2, z: 1 },
      setCurrentPageCalls: 0,
    })

    dispose()
  } finally {
    globalThis.window = previousWindow
    globalThis.PopStateEvent = previousPopStateEvent
    dom.window.close()
  }
})
