import type { CanvasClipShapeLike } from '../canvas-clip-shape-predicate'

export function isProjectMapShape(shape: CanvasClipShapeLike): boolean {
  return shape.type === 'svg-page' || shape.type === 'html-page'
}
