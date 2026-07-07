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

test('html page navigation history restores page and camera', async () => {
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
      pageId: 'page:one',
      camera: { x: 1, y: 2, z: 1 },
    })

    editor.setCurrentPage('page:two' as TLPageId)
    editor.setCamera({ x: 30, y: 40, z: 2 })
    recordHtmlNavigationEnd(editor)
    await new Promise(resolve => setTimeout(resolve, 5))

    assert.deepEqual(htmlNavigationLocationFromHistoryState(window.history.state), {
      pageId: 'page:two',
      camera: { x: 30, y: 40, z: 2 },
    })

    window.dispatchEvent(new PopStateEvent('popstate', { state: initialState }))
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(editor.read(), {
      pageId: 'page:one',
      camera: { x: 1, y: 2, z: 1 },
      setCurrentPageCalls: 2,
    })

    dispose()
  } finally {
    globalThis.window = previousWindow
    globalThis.PopStateEvent = previousPopStateEvent
    dom.window.close()
  }
})

test('html page navigation history pushes repeated camera locations as explicit places', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://tlda.test/?doc=world-md' })
  const previousWindow = globalThis.window
  globalThis.window = dom.window as unknown as Window & typeof globalThis

  try {
    const editor = makeEditor()
    const dispose = installHtmlNavigationHistory(editor)
    recordHtmlNavigationStart(editor)
    const pushedStates: unknown[] = []
    const originalPushState = window.history.pushState.bind(window.history)
    window.history.pushState = (state: unknown, title: string, url?: string | URL | null) => {
      pushedStates.push(state)
      return originalPushState(state, title, url)
    }

    recordHtmlNavigationEnd(editor)
    await new Promise(resolve => setTimeout(resolve, 5))
    recordHtmlNavigationEnd(editor)
    await new Promise(resolve => setTimeout(resolve, 5))

    assert.equal(pushedStates.length, 2)
    assert.deepEqual(pushedStates.map(htmlNavigationLocationFromHistoryState), [
      { pageId: 'page:one', camera: { x: 1, y: 2, z: 1 } },
      { pageId: 'page:one', camera: { x: 1, y: 2, z: 1 } },
    ])
    dispose()
  } finally {
    globalThis.window = previousWindow
    dom.window.close()
  }
})
