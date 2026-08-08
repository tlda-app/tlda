import test from 'node:test'
import assert from 'node:assert/strict'
import { createWMCore } from '../src/wm/wm-core.ts'
import { mountGradingPanes, connectorEndpoints, gradingViewportId, gradingLayerId } from '../src/classroom/gradingPanes.ts'

// The marking surface as WM layers. Skip, 10 July: "we have to make sure that
// we're, like, writing it on the window manager. Properly."
//
// A fake editor standing in for tldraw's, mirroring its real conversion:
//   pageToScreen: (x + camera.x) * camera.z + screenBounds.x
// The screenBounds term is what places the two panes apart, so it is the term
// this has to get right.

function fakeEditor(viewports) {
  const get = id => {
    const v = viewports[id]
    if (!v) throw new Error(`No viewport registered: ${id}`)
    return v
  }
  return {
    pageToScreen: (p, { viewportId }) => {
      const { camera: c, screenBounds: b } = get(viewportId)
      return { x: (p.x + c.x) * c.z + b.x, y: (p.y + c.y) * c.z + b.y }
    },
    screenToPage: (p, { viewportId }) => {
      const { camera: c, screenBounds: b } = get(viewportId)
      return { x: (p.x - b.x) / c.z - c.x, y: (p.y - b.y) / c.z - c.y }
    },
    getViewport: id => get(id),
    updateViewport: (id, patch) => { viewports[id] = { ...get(id), ...patch } },
  }
}

const INPUT = {
  assignmentId: 'hw5',
  problemId: 'ans-exr-hearts',
  studentId: 's-ada',
  owner: { userId: 'fleet:skip', deviceId: 'ipad' },
  source: 'classroom-marking',
}

const LAYOUT = {
  'official-solution': { x: 0, y: 0, w: 880, h: 1200 },
  'student-submission': { x: 900, y: 0, w: 880, h: 1200 },
}

function mounted({ solutionCamera = { x: 0, y: 0, z: 1 }, submissionCamera = { x: 0, y: 0, z: 1 } } = {}) {
  const viewports = {
    [gradingViewportId('official-solution', 'hw5', 's-ada')]: { camera: solutionCamera, screenBounds: { x: 0, y: 0 } },
    [gradingViewportId('student-submission', 'hw5', 's-ada')]: { camera: submissionCamera, screenBounds: { x: 900, y: 0 } },
  }
  const wm = createWMCore({ rootLayerId: 'screen' })
  const panes = mountGradingPanes(wm, fakeEditor(viewports), LAYOUT, INPUT)
  return { wm, panes, viewports }
}

test('both panes mount as viewport-backed layers carrying his model', () => {
  const { panes } = mounted()
  assert.equal(panes.length, 2)
  const solution = panes.find(p => p.pane === 'official-solution')
  assert.equal(solution.request.payload.assignmentId, 'hw5')
  assert.equal(solution.request.payload.studentId, 's-ada')
  assert.equal(solution.request.payload.problemId, 'ans-exr-hearts')
  assert.equal(solution.request.payload.layerScope, 'grading-draft')
  assert.equal(solution.request.payload.pane, 'official-solution')
  // Per-student layer id: marking one student must not land on another's layer.
  const submission = panes.find(p => p.pane === 'student-submission')
  assert.notEqual(solution.request.layerId, undefined)
  assert.equal(solution.request.layerId, submission.request.layerId,
    'both panes of one student share that student\'s layer')
})

test('a connector spans the two panes, in screen coordinates', () => {
  const { wm } = mounted()
  const ends = connectorEndpoints(
    wm,
    { layerId: gradingLayerId('official-solution', 'hw5', 's-ada'), point: { x: 40, y: 100 } },
    { layerId: gradingLayerId('student-submission', 'hw5', 's-ada'), point: { x: 40, y: 160 } },
  )
  assert.deepEqual(ends.from, { x: 40, y: 100 })
  assert.deepEqual(ends.to, { x: 940, y: 160 })
  assert.equal(ends.to.x - ends.from.x, 900, 'the panes collapsed onto one origin')
})

test('scrolling one pane moves only its end of the arrow', () => {
  // The behaviour, not the arithmetic: he scrolls the student's answer to find
  // their working, and his end of the arrow stays put.
  const before = mounted()
  const endsBefore = connectorEndpoints(
    before.wm,
    { layerId: gradingLayerId('official-solution', 'hw5', 's-ada'), point: { x: 40, y: 100 } },
    { layerId: gradingLayerId('student-submission', 'hw5', 's-ada'), point: { x: 40, y: 160 } },
  )

  const after = mounted({ submissionCamera: { x: 0, y: -220, z: 1 } })
  const endsAfter = connectorEndpoints(
    after.wm,
    { layerId: gradingLayerId('official-solution', 'hw5', 's-ada'), point: { x: 40, y: 100 } },
    { layerId: gradingLayerId('student-submission', 'hw5', 's-ada'), point: { x: 40, y: 160 } },
  )

  assert.deepEqual(endsAfter.from, endsBefore.from, 'his end of the arrow moved when he scrolled theirs')
  assert.equal(endsAfter.to.y, -60, 'their end did not follow the scroll')
})

test('zooming one pane does not rescale the other', () => {
  const { wm } = mounted({ submissionCamera: { x: 0, y: 0, z: 2 } })
  const ends = connectorEndpoints(
    wm,
    { layerId: gradingLayerId('official-solution', 'hw5', 's-ada'), point: { x: 40, y: 100 } },
    { layerId: gradingLayerId('student-submission', 'hw5', 's-ada'), point: { x: 40, y: 100 } },
  )
  assert.deepEqual(ends.from, { x: 40, y: 100 })
  assert.deepEqual(ends.to, { x: 980, y: 200 })
})

test('each pane hands CanvasClipPanel the surface it expects', () => {
  // CanvasClipPanel owns the viewport lifecycle — it registers the viewport and
  // syncs its camera. A pane supplies the id and the surface and lets it, so
  // there is one place doing that rather than two that can disagree.
  const { wm, panes } = mounted()
  for (const pane of panes) {
    assert.equal(pane.wmSurface.wm, wm)
    assert.equal(pane.wmSurface.layerId, pane.layerId)
    assert.equal(pane.wmSurface.surfaceId, pane.request.surfaceId)
    assert.ok(wm.hasLayer(pane.wmSurface.layerId), 'the surface names a layer that does not exist')
  }
  // Two panes, two viewports — the whole point.
  assert.equal(new Set(panes.map(p => p.viewportId)).size, 2)
})
