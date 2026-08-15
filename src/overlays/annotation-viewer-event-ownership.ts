import {
  managedSurfaceEventOwner,
  type ManagedSurfaceHitPolicy,
} from '../../packages/tldraw-wm/src/managed-surfaces.ts'

export type AnnotationViewerInteractionState = 'hovering' | 'pinned' | 'navigated'

const CHROME_SELECTOR = '.annotation-viewer-nav-btn, .annotation-viewer-resize'
const CANVAS_SELECTOR = '.annotation-viewer-canvas [data-viewport-id], .annotation-viewer-canvas .tl-container, .annotation-viewer-canvas .tl-canvas'

export function annotationViewerCanvasOwnsEvent(
  hitPolicy: ManagedSurfaceHitPolicy,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false
  const region = target.closest(CHROME_SELECTOR)
    ? 'chrome'
    : target.closest(CANVAS_SELECTOR) ? 'content' : 'outside'
  return managedSurfaceEventOwner(hitPolicy, region) === 'content'
}
