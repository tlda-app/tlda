export type AnnotationViewerInteractionState = 'hovering' | 'pinned' | 'navigated'

const CHROME_SELECTOR = '.annotation-viewer-nav-btn, .annotation-viewer-resize'
const CANVAS_SELECTOR = '.annotation-viewer-canvas [data-viewport-id], .annotation-viewer-canvas .tl-container, .annotation-viewer-canvas .tl-canvas'

export function annotationViewerCanvasOwnsEvent(
  state: AnnotationViewerInteractionState,
  target: EventTarget | null,
): boolean {
  if (state === 'hovering') return false
  if (!(target instanceof Element)) return false
  if (target.closest(CHROME_SELECTOR)) return false
  return !!target.closest(CANVAS_SELECTOR)
}
