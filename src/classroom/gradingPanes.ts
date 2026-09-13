import type { WMCore } from '../wm/wm-core.ts'
import type { ManagedSurfaceOwner, ManagedSurfaceRect } from '../wm/managed-surfaces.ts'
import { requestManagedSurface } from '../wm/managed-surfaces.ts'
import { createHomeworkGradingSurfaceRequest } from '../wm/homework-grading-surface.ts'
import { tldrawForkViewportAdapter } from '../wm/tldraw-fork-viewport-adapter.ts'
import { ensureViewLayer } from '../wm/editor-wm.ts'
import { createCanvasClipPanelPlan } from '../wm/canvas-clip-panel.ts'

// The two panes of the marking surface, as window-manager layers.
//
// Skip, 10 July, about this feature: "we have to make sure that we're, like,
// writing it on the window manager. Properly." His solution is one viewport,
// the student's answer is another, each with its own camera, and the arrow he
// draws between them is a connector across the two.
//
// A tldraw viewport is a camera over a page, not a separate coordinate space,
// so the panes share one page and one store. What differs is only which camera
// and which region of the screen each is seen through.

export type GradingPane = 'official-solution' | 'student-submission'

export interface GradingPaneInput {
  assignmentId: string
  problemId: string
  studentId: string
  owner: Partial<ManagedSurfaceOwner>
  source: string
}

/** The width of one pane, from the window. One derivation, used by the DOM
 * and by each pane's camera. */
export function gradingPanelWidth(): number {
  return Math.max(320, Math.floor((window.innerWidth - 48) / 2))
}

/** How much of the viewport height one pane may take. */
export const GRADING_PANE_MAX_HEIGHT_FRACTION = 0.88

export function gradingViewportId(pane: GradingPane, assignmentId: string, studentId: string): string {
  return `wm:grading:${pane}:${assignmentId}:${studentId}`
}

export function gradingLayerId(pane: GradingPane, assignmentId: string, studentId: string): string {
  return `grading-pane:${pane}:${assignmentId}:${studentId}`
}

/**
 * Describe one pane. The request carries his model — assignment, problem,
 * student, role, pane, layer scope — and `homework-grading-surface.ts` has
 * encoded that since before this feature was picked up; it was simply never
 * used by anything that shipped.
 */
export function gradingPaneRequest(pane: GradingPane, bounds: ManagedSurfaceRect, input: GradingPaneInput) {
  return createHomeworkGradingSurfaceRequest({
    surfaceKey: gradingViewportId(pane, input.assignmentId, input.studentId),
    bounds,
    owner: input.owner,
    assignmentId: input.assignmentId,
    problemId: input.problemId,
    studentId: input.studentId,
    role: 'instructor',
    pane,
    // Marking happens in his own workspace and is committed to the student
    // afterwards — his June model, and the reason drafts are not written
    // straight onto their layer.
    layerScope: 'grading-draft',
    source: input.source,
  })
}

/**
 * Register both panes as viewport-backed WM layers.
 *
 * `editor` is tldraw's Editor; it is passed through the adapter rather than
 * used directly so the page/screen arithmetic stays tldraw's own.
 */
/**
 * The pane geometry the camera needs. Passed in rather than read from `window`
 * here, because `ClassroomGradingSurface` already computes `panelWidth` for the
 * DOM and two derivations of one number would drift apart silently.
 */
export interface GradingPaneViewport {
  panelWidth: number
  viewportHeight: number
  maxHeightFraction: number
}

export function mountGradingPanes(
  wm: WMCore,
  editor: Parameters<typeof tldrawForkViewportAdapter>[0],
  layout: Record<GradingPane, ManagedSurfaceRect>,
  input: GradingPaneInput,
  viewport: GradingPaneViewport,
) {
  const adapter = tldrawForkViewportAdapter(editor)
  const panes = (Object.keys(layout) as GradingPane[]).map(pane => {
    const bounds = layout[pane]
    const declaredRequest = gradingPaneRequest(pane, bounds, input)
    const request = typeof window !== 'undefined' ? requestManagedSurface(window, declaredRequest) : declaredRequest
    const viewportId = gradingViewportId(pane, input.assignmentId, input.studentId)
    const layerId = gradingLayerId(pane, input.assignmentId, input.studentId)
    // The pane has to LOOK at its own bounds, and two obvious ways of telling
    // it to are both wrong. Written out because each cost a crash.
    //
    // NOT `transform`. For a viewport-backed layer
    //     localTransform = layer.transform + camera * trackFactor
    // and `CanvasClipPanel` reads that sum and writes it back as the camera, so
    // a non-zero transform is re-added every cycle: -1648, -2472, -3296. Zero
    // is a stable fixed point, which is why this was latent until the panes
    // were aimed at all.
    //
    // NOT `wm.setCamera` here. That writes through the adapter to
    // `editor.updateViewport`, which merges with an existing viewport — and at
    // mount there is none, so it throws "A viewport must have screenBounds and
    // camera". `CanvasClipPanel` registers the viewport later, in an effect.
    //
    // So: the layer's own `camera`, set at definition. It writes nothing
    // through. Before registration `WMCore.camera()` falls back to it, so the
    // first paint is aimed; after registration the panel's guarded sync pushes
    // the same value into the viewport, and `transform` stays zero, so the
    // fixed point is the aim.
    const plan = createCanvasClipPanelPlan({
      bounds, panelWidth: viewport.panelWidth, viewportHeight: viewport.viewportHeight,
      maxHeightFraction: viewport.maxHeightFraction,
    })
    ensureViewLayer(wm, layerId, {
      parent: wm.rootLayerId,
      policy: request.cameraPolicy,
      camera: plan.camera,
      backing: { kind: 'viewport', viewportId, editor: adapter },
    })
    return {
      pane,
      request,
      viewportId,
      layerId,
      bounds,
      // The shape CanvasClipPanel wants. It owns the viewport's lifecycle —
      // registering it, syncing its camera — so a pane hands it an id and a
      // surface and lets it do that, rather than a second place doing it too.
      wmSurface: { wm, layerId, surfaceId: request.surfaceId },
    }
  })
  return panes
}

/**
 * Where to draw a connector, in screen coordinates.
 *
 * Both endpoints are page points — one in his solution, one in their answer.
 * Each is mapped through its own pane's camera, which is what makes the arrow
 * follow when he scrolls or zooms either side independently.
 */
export function connectorEndpoints(
  wm: WMCore,
  from: { layerId: string; point: { x: number; y: number } },
  to: { layerId: string; point: { x: number; y: number } },
) {
  return {
    from: wm.translate(from.point, from.layerId, wm.rootLayerId),
    to: wm.translate(to.point, to.layerId, wm.rootLayerId),
  }
}
