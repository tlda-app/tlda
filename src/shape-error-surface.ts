export const SHAPE_RENDER_ERROR_EVENT = 'tlda-shape-render-error'

export interface ShapeRenderErrorDetail {
  shapeType: string
  message: string
  stack: string | null
  componentStack: string | null
}

export function shapeRenderErrorMessage(detail: Pick<ShapeRenderErrorDetail, 'shapeType' | 'message'>): string {
  return `Shape ${detail.shapeType} crashed: ${detail.message}`
}

export function dispatchShapeRenderError(detail: ShapeRenderErrorDetail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SHAPE_RENDER_ERROR_EVENT, { detail }))
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
