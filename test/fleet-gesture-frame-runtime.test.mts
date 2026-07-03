import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getGestureViewportCamera,
  getGestureViewportContainer,
} from '../src/wm/gesture-frame'

test('gesture frame adapter reads named viewport camera before editor camera', () => {
  const editor = {
    getViewport: (id: string) => ({ camera: { x: id.length, y: 2, z: 3 } }),
    getCamera: () => ({ x: 10, y: 20, z: 30 }),
  }
  assert.deepEqual(getGestureViewportCamera(editor as any, 'abc'), { x: 3, y: 2, z: 3 })
})

test('gesture frame adapter falls back to editor camera and container', () => {
  const container = { nodeType: 1 }
  const editor = {
    getViewport: () => { throw new Error('missing viewport') },
    getCamera: () => ({ x: 10, y: 20, z: 30 }),
    getContainer: () => container,
  }
  assert.deepEqual(getGestureViewportCamera(editor as any, 'missing'), { x: 10, y: 20, z: 30 })
  assert.equal(getGestureViewportContainer(editor as any), container)
})

test('gesture frame adapter uses host-supplied viewport selectors', () => {
  const previousDocument = (globalThis as any).document
  const previousHTMLElement = (globalThis as any).HTMLElement
  class TestElement {
    nodeType = 1
    querySelector(_selector: string): unknown {
      return null
    }
  }
  const selected = new TestElement()
  try {
    ;(globalThis as any).HTMLElement = TestElement
    ;(globalThis as any).document = {
      querySelector: (selector: string) => {
        assert.equal(selector, '[data-host-viewport="hud"]')
        return {
          querySelector: (childSelector: string) => {
            assert.equal(childSelector, '.host-canvas')
            return selected
          },
        }
      },
    } as any
    const editor = {
      getContainer: () => ({ nodeType: 1 }),
    }
    assert.equal(
      getGestureViewportContainer(editor as any, 'hud', {
        viewportRoot: (viewportId) => `[data-host-viewport="${viewportId}"]`,
        viewportCanvas: '.host-canvas',
      }),
      selected,
    )
  } finally {
    ;(globalThis as any).document = previousDocument
    ;(globalThis as any).HTMLElement = previousHTMLElement
  }
})
