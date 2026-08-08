import test from 'node:test'
import assert from 'node:assert/strict'
import { createWMCore } from '../src/wm/wm-core.ts'

// SPIKE, not a feature. Skip, 10 July, about grading: "writing it on the window
// manager. Properly. And if the window manager, like, doesn't support what we
// need, maybe that's something to think about, like, putting in the window
// manager. This is like a test case for that."
//
// The feared gap was cross-viewport arrows: his solution in one viewport, the
// student's answer in another, an arrow drawn between them. This exercises
// whether wm-core can already map a point from one viewport-backed layer into
// another, which is the coordinate half of that arrow.
//
// It can. LayerBacking has a 'viewport' kind and layerToParent/parentToLayer
// already route through ForkViewportAdapter — but nothing in the app implements
// that adapter, so this path had never been run.

// A stand-in for what tldraw's editor would supply: two named viewports, each
// with its own camera over the same page.
function forkAdapter(cameras) {
  return {
    pageToScreen: (p, { viewportId }) => {
      const c = cameras[viewportId]
      return { x: (p.x + c.x) * c.z, y: (p.y + c.y) * c.z }
    },
    screenToPage: (p, { viewportId }) => {
      const c = cameras[viewportId]
      return { x: p.x / c.z - c.x, y: p.y / c.z - c.y }
    },
    getCamera: id => cameras[id],
    setCamera: (id, c) => { cameras[id] = c },
  }
}

function twoPanes() {
  const cameras = {
    'solution': { x: 0, y: 0, z: 1 },
    'submission': { x: -100, y: -40, z: 2 },   // scrolled and zoomed differently
  }
  const wm = createWMCore({ rootLayerId: 'screen' })
  const editor = forkAdapter(cameras)
  wm.defineLayer('pane:solution', { parent: 'screen', backing: { kind: 'viewport', viewportId: 'solution', editor } })
  wm.defineLayer('pane:submission', { parent: 'screen', backing: { kind: 'viewport', viewportId: 'submission', editor } })
  return { wm, cameras }
}

test('a point maps from one viewport-backed pane into the other', () => {
  const { wm } = twoPanes()
  // Page point in his solution → the same screen location expressed in the
  // student's pane. This is the arrow's far endpoint.
  const inSubmission = wm.translate({ x: 10, y: 5 }, 'pane:solution', 'pane:submission')
  // solution: (10+0)*1 = 10 screen ; submission: 10/2 - (-100) = 105
  assert.deepEqual(inSubmission, { x: 105, y: 42.5 })
})

test('the mapping follows a camera change, which is what makes an arrow track', () => {
  const { wm, cameras } = twoPanes()
  const before = wm.translate({ x: 10, y: 5 }, 'pane:solution', 'pane:submission')
  cameras['submission'] = { x: -100, y: -40, z: 4 }   // student pane zooms in
  const after = wm.translate({ x: 10, y: 5 }, 'pane:solution', 'pane:submission')
  assert.notDeepEqual(before, after, 'endpoint did not move when its viewport camera changed')
  assert.deepEqual(after, { x: 102.5, y: 41.25 })
})

test('round-tripping through the other pane returns the original point', () => {
  const { wm } = twoPanes()
  const there = wm.translate({ x: 33, y: -7 }, 'pane:solution', 'pane:submission')
  const back = wm.translate(there, 'pane:submission', 'pane:solution')
  assert.ok(Math.abs(back.x - 33) < 1e-9 && Math.abs(back.y - -7) < 1e-9, `round trip lost the point: ${JSON.stringify(back)}`)
})

test('the camera of a viewport-backed layer comes from the viewport, not the layer', () => {
  const { wm, cameras } = twoPanes()
  assert.deepEqual(wm.camera('pane:submission'), cameras['submission'])
  wm.setCamera('pane:submission', { x: -5, y: -5, z: 3 })
  assert.deepEqual(cameras['submission'], { x: -5, y: -5, z: 3 }, 'setCamera did not reach the viewport')
})
