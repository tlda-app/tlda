/**
 * A grading pane aims at its own bounds — before the viewport exists, after it
 * registers, and without the sync running away.
 *
 * THREE defects, and the second and third were each caused by fixing the first
 * the obvious way. All three are covered here because the fix has to satisfy
 * all three at once and two plausible repairs each satisfy only two.
 *
 * **1. Aim.** Measured on the real surface: the two viewport FRAMES were
 * correctly distinct — x=16 and x=608, 592 apart, the pane geometry — while
 * both pane cameras read x=0, y=0, z=1. Placement right, aim absent, so both
 * panes painted whichever page sits at the origin. The student's page is at
 * x=0 and the solution at x=824, so the instructor saw the student's work
 * twice and his own solution nowhere.
 *
 * **2. Runaway — REJECTED ROUTE: the aim as the layer's `transform`.** For a
 * viewport-backed layer,
 *
 *     localTransform = layer.transform + camera * trackFactor
 *
 * where `camera` is the editor's viewport camera. `CanvasClipPanel` reads that
 * sum and writes it back as the camera, so a non-zero `transform` is re-added
 * every cycle: -1648 → -2472 → -3296 → -4120. `transform.x = 0` is a stable
 * fixed point, which is why this was latent until something aimed the panes.
 * In the browser: `Maximum update depth exceeded`, nothing painted.
 *
 * **3. Ordering — REJECTED ROUTE: writing the camera through at mount.**
 * `wm.setCamera` on a viewport-backed layer writes through to
 * `editor.updateViewport`, which MERGES with the existing viewport:
 *
 *     const next = { ...prev, ...patch, id, … }
 *     if (!next.screenBounds || !next.camera) throw …
 *
 * `mountGradingPanes` runs before `CanvasClipPanel` registers the viewport, so
 * there is no `prev`, no `screenBounds`, and it throws `A viewport must have
 * screenBounds and camera.` In the browser: nothing painted, again.
 *
 * So the stub below THROWS on `updateViewport` for an unregistered viewport,
 * exactly as tldraw does. A stub that quietly accepted the write is what let
 * attempt 2 reach the browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWMCore } from '../packages/tldraw-wm/src/wm-core.ts'
import { canvasClipSurfaceCamera } from '../packages/tldraw-wm/src/canvas-clip-panel.ts'
import { mountGradingPanes } from '../src/classroom/gradingPanes.ts'

// Where the two pages actually sit on the shared tldraw page, from the store.
const STUDENT = { x: 0, y: 0, w: 800, h: 1000 }
const SOLUTION = { x: 824, y: 0, w: 800, h: 1000 }
const VIEWPORT = { panelWidth: 576, viewportHeight: 834, maxHeightFraction: 0.88 }

type Camera = { x: number; y: number; z: number }

/**
 * tldraw's viewport semantics, as far as this surface uses them.
 *
 * `updateViewport` merges and throws when the result has no `screenBounds` —
 * so a write before registration fails here the way it fails in the browser.
 * `register` is what `CanvasClipPanel` does later, in an effect.
 */
function stubEditor() {
  const viewports = new Map<string, { camera: Camera; screenBounds: object }>()
  const editor = {
    getViewport: (viewportId: string) => {
      const v = viewports.get(viewportId)
      if (!v) throw new Error(`No viewport registered with id "${viewportId}"`)
      return v
    },
    updateViewport: (viewportId: string, patch: { camera?: Camera }) => {
      const prev = viewports.get(viewportId)
      const next = { ...prev, ...patch }
      if (!next.screenBounds || !next.camera) {
        throw new Error('A viewport must have screenBounds and camera.')
      }
      viewports.set(viewportId, next as { camera: Camera; screenBounds: object })
    },
    pageToScreen: (p: { x: number; y: number }) => p,
    screenToPage: (p: { x: number; y: number }) => p,
  }
  return {
    editor: editor as never,
    /** What CanvasClipPanel's effect does: the viewport comes into existence. */
    register: (viewportId: string, camera: Camera) => {
      viewports.set(viewportId, { camera, screenBounds: { x: 0, y: 0, w: 576, h: 834 } })
    },
    /**
     * The panel's own sync, including its guard: it only pushes a camera into a
     * viewport that already has screenBounds.
     */
    sync: (viewportId: string, camera: Camera) => {
      if (viewports.get(viewportId)?.screenBounds) editor.updateViewport(viewportId, { camera })
    },
  }
}

const mount = (wm: ReturnType<typeof createWMCore>, editor: never) =>
  mountGradingPanes(wm, editor, {
    'official-solution': SOLUTION,
    'student-submission': STUDENT,
  }, {
    assignmentId: 'walk-2',
    problemId: 'p1',
    studentId: 'walk2-a',
    owner: { userId: 'u', deviceId: 'd' },
    source: 'test',
  }, VIEWPORT)

test('mounting the panes does not touch a viewport that does not exist yet', () => {
  // THE ORDERING GUARD, and the one the previous suite could not express.
  // `mountGradingPanes` runs before any viewport is registered. Anything that
  // writes a camera through at mount throws here, exactly as it did on the
  // surface.
  const wm = createWMCore({ rootLayerId: 'screen' })
  const { editor } = stubEditor()
  assert.doesNotThrow(() => mount(wm, editor))
})

test('each pane aims at its own bounds before its viewport registers', () => {
  // First paint happens with no viewport yet, so the aim has to be readable
  // from the layer alone or the panes are wrong on the frame a reader sees.
  const wm = createWMCore({ rootLayerId: 'screen' })
  const { editor } = stubEditor()
  const panes = mount(wm, editor)
  for (const [kind, bounds] of [
    ['official-solution', SOLUTION],
    ['student-submission', STUDENT],
  ] as const) {
    const pane = panes.find(p => p.pane === kind)!
    const camera = canvasClipSurfaceCamera({ wm, layerId: pane.layerId }, false)
    // `===` not `assert.equal`: the student's bounds start at 0, the planner
    // yields `0`, the expectation is `-0`, and `assert/strict` splits those
    // with `Object.is`. Correct code failed this on the very pane the defect
    // was about.
    assert.ok(camera.x === -bounds.x, `${kind} aims at ${camera.x}, not its own left edge ${-bounds.x}`)
  }
})

test('the aim survives the viewport registering and the panel syncing', () => {
  // The full order of events on the real surface: mount → register → sync.
  const wm = createWMCore({ rootLayerId: 'screen' })
  const { editor, register, sync } = stubEditor()
  const panes = mount(wm, editor)

  for (const pane of panes) {
    const surface = { wm, layerId: pane.layerId }
    const aimed = canvasClipSurfaceCamera(surface, false)
    register(pane.viewportId, aimed)     // CanvasClipPanel's effect
    sync(pane.viewportId, canvasClipSurfaceCamera(surface, false))
  }

  for (const [kind, bounds] of [
    ['official-solution', SOLUTION],
    ['student-submission', STUDENT],
  ] as const) {
    const pane = panes.find(p => p.pane === kind)!
    const camera = canvasClipSurfaceCamera({ wm, layerId: pane.layerId }, false)
    assert.ok(camera.x === -bounds.x, `${kind} lost its aim at registration: ${camera.x}`)
  }
})

test('the panel/layer camera sync settles instead of running away', () => {
  // THE RUNAWAY GUARD. If reading and writing disagree by a constant, every
  // cycle adds it again and React tears the surface down. Driven directly,
  // through the panel's guarded sync, after registration.
  const wm = createWMCore({ rootLayerId: 'screen' })
  const { editor, register, sync } = stubEditor()
  const panes = mount(wm, editor)

  for (const pane of panes) {
    const surface = { wm, layerId: pane.layerId }
    register(pane.viewportId, canvasClipSurfaceCamera(surface, false))
    const seen: string[] = []
    for (let i = 0; i < 12; i += 1) {
      sync(pane.viewportId, canvasClipSurfaceCamera(surface, false))
      const next = canvasClipSurfaceCamera(surface, false)
      seen.push(`${next.x},${next.y},${next.z}`)
    }
    assert.ok(
      seen[seen.length - 1] === seen[seen.length - 2],
      `${pane.pane} never settles — the cycle walks: ${seen.slice(0, 5).join(' → ')}…`,
    )
  }
})

test('the two panes do not share a camera', () => {
  const wm = createWMCore({ rootLayerId: 'screen' })
  const { editor } = stubEditor()
  const panes = mount(wm, editor)
  const [s, t] = ['official-solution', 'student-submission']
    .map(kind => canvasClipSurfaceCamera({ wm, layerId: panes.find(p => p.pane === kind)!.layerId }, false))
  assert.notDeepEqual({ x: s.x, y: s.y }, { x: t.x, y: t.y },
    'both panes aim at the same point, so they paint the same page')
})
