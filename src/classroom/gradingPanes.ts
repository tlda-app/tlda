import type { WMCore } from '../wm/wm-core.ts'
import type { ManagedSurfaceOwner, ManagedSurfaceRect } from '../wm/managed-surfaces.ts'
import { requestManagedSurface } from '../wm/managed-surfaces.ts'
import { createHomeworkGradingSurfaceRequest } from '../wm/homework-grading-surface.ts'
import { tldrawForkViewportAdapter } from '../wm/tldraw-fork-viewport-adapter.ts'
import { ensureViewLayer } from '../wm/editor-wm.ts'

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
export function mountGradingPanes(
  wm: WMCore,
  editor: Parameters<typeof tldrawForkViewportAdapter>[0],
  layout: Record<GradingPane, ManagedSurfaceRect>,
  input: GradingPaneInput,
) {
  const adapter = tldrawForkViewportAdapter(editor)
  const panes = (Object.keys(layout) as GradingPane[]).map(pane => {
    const bounds = layout[pane]
    const declaredRequest = gradingPaneRequest(pane, bounds, input)
    const request = typeof window !== 'undefined' ? requestManagedSurface(window, declaredRequest) : declaredRequest
    const viewportId = gradingViewportId(pane, input.assignmentId, input.studentId)
    const layerId = gradingLayerId(pane, input.assignmentId, input.studentId)
    ensureViewLayer(wm, layerId, {
      parent: wm.rootLayerId,
      policy: request.cameraPolicy,
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
