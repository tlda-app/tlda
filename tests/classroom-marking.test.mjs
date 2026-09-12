import test from 'node:test'
import assert from 'node:assert/strict'
import { framePair } from '../src/classroom/marking.ts'

// Framing the pair, which is all this module still decides.
//
// It used to also decide which marks were unreturned, from a `meta.draft` flag
// and a parent/child link to the submission block. Those tests were removed
// with the mechanism: they passed by building shapes the app never made —
// `{ parentId: SUBMISSION, meta: { draft: true } }` — while the running app
// produced page-parented shapes with no `draft` key, so every assertion held
// and nothing was ever withheld. Withholding is a sync room now; see
// `tests/classroom-room-access.test.mjs`.

// Navigating to a problem centred the submission and pushed his solution off
// the right edge — headings cut mid-word on the surface where he compares them.
// Framing is a pan, not a zoom to fit: the pair already fits at this zoom, and
// rescaling would shrink his solution every time he changed problem.

function framingEditor({ z = 0.8621, viewportWidth = 1600, camera = { x: 99.8, y: -91.5, z } } = {}) {
  const bounds = {
    'shape:sub': { x: 0, y: 0, w: 880, h: 1200 },
    'shape:sol': { x: 900, y: 0, w: 880, h: 1200 },
  }
  let current = { ...camera, z }
  return {
    getShapePageBounds: id => bounds[id] ?? null,
    getCamera: () => current,
    setCamera: c => { current = c },
    getViewportScreenBounds: () => ({ w: viewportWidth }),
    get camera() { return current },
  }
}

test('framing centres the pair without changing the zoom', () => {
  const editor = framingEditor()
  const zoomBefore = editor.getCamera().z
  const yBefore = editor.getCamera().y
  assert.equal(framePair(editor, ['shape:sub', 'shape:sol']), true)

  const after = editor.getCamera()
  assert.equal(after.z, zoomBefore, 'his solution was rescaled')
  assert.equal(after.y, yBefore, 'framing moved the view off the problem it had just found')

  // Both panes on screen: left edge at or after 0, right edge at or before 1600.
  const screenLeft = (0 + after.x) * after.z
  const screenRight = (900 + 880 + after.x) * after.z
  assert.ok(screenLeft >= 0, `left pane starts off screen at ${screenLeft}`)
  assert.ok(screenRight <= 1600, `right pane runs past the edge at ${screenRight}`)
})

test('framing is symmetric — equal margin either side', () => {
  const editor = framingEditor()
  framePair(editor, ['shape:sub', 'shape:sol'])
  const { x, z } = editor.getCamera()
  const leftGap = (0 + x) * z
  const rightGap = 1600 - (1780 + x) * z
  assert.ok(Math.abs(leftGap - rightGap) < 0.5, `lopsided: ${leftGap} vs ${rightGap}`)
})

test('a single pane is not framed as a pair', () => {
  const editor = framingEditor()
  const before = { ...editor.getCamera() }
  assert.equal(framePair(editor, ['shape:sub']), false)
  assert.deepEqual(editor.getCamera(), before, 'the camera moved with nothing to frame')
})
