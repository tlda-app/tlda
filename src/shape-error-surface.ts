export const SHAPE_RENDER_ERROR_EVENT = 'tlda-shape-render-error'

/**
 * The shape type a build-failure report travels under.
 *
 * A failed newest build over a still-served older render reports through this
 * same event — the same surface, the same log channel, no bespoke banner. It
 * is a REPORT, not a crash: the document on screen is the last success, so
 * the boundary records it and leaves the pages up. Only a render crash takes
 * the screen.
 */
export const BUILD_FAILURE_SHAPE_TYPE = 'document-build'

export interface ShapeRenderErrorDetail {
  shapeType: string
  message: string
  stack: string | null
  componentStack: string | null
}

export function isBuildFailureReport(detail: unknown): boolean {
  return (
    !!detail &&
    typeof detail === 'object' &&
    (detail as Partial<ShapeRenderErrorDetail>).shapeType === BUILD_FAILURE_SHAPE_TYPE
  )
}

export function shapeRenderErrorMessage(detail: Pick<ShapeRenderErrorDetail, 'shapeType' | 'message'>): string {
  if (detail.shapeType === BUILD_FAILURE_SHAPE_TYPE) return `Build failed: ${detail.message}`
  return `Shape ${detail.shapeType} crashed: ${detail.message}`
}

export function dispatchShapeRenderError(detail: ShapeRenderErrorDetail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SHAPE_RENDER_ERROR_EVENT, { detail }))
}

export function dispatchBuildFailureReport(message: string) {
  dispatchShapeRenderError({
    shapeType: BUILD_FAILURE_SHAPE_TYPE,
    message,
    stack: null,
    componentStack: null,
  })
}

export function errorFromShapeRenderEvent(event: Event): Error | null {
  const detail = (event as CustomEvent<Partial<ShapeRenderErrorDetail>>).detail
  if (!detail || !detail.shapeType || !detail.message) return null
  const error = new Error(shapeRenderErrorMessage({
    shapeType: String(detail.shapeType),
    message: String(detail.message),
  }))
  error.stack = typeof detail.stack === 'string' ? detail.stack : undefined
  return error
}
