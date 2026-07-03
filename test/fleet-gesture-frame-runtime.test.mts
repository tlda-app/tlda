import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getGestureViewportCamera,
  getGestureViewportContainer,
} from '../src/overlays/fleet-gesture-frame'

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
