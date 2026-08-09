export interface RectLike {
  x: number
  y: number
  w: number
  h: number
}

export interface PointLike {
  x: number
  y: number
}

export function pointInRect(point: PointLike, rect: RectLike): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  )
}

export function connectorPanes(
  start: PointLike,
  end: PointLike,
  submission: RectLike,
  solution: RectLike,
): { start: 'submission' | 'solution'; end: 'submission' | 'solution' } | null {
  const startPane = pointInRect(start, submission)
    ? 'submission'
    : pointInRect(start, solution)
      ? 'solution'
      : null
  const endPane = pointInRect(end, submission)
    ? 'submission'
    : pointInRect(end, solution)
      ? 'solution'
      : null
  if (!startPane || !endPane || startPane === endPane) return null
  return { start: startPane, end: endPane }
}

export function isClassroomConnectorArrow(
  start: PointLike,
  end: PointLike,
  submission: RectLike,
  solution: RectLike,
): boolean {
  return connectorPanes(start, end, submission, solution) !== null
}

export function connectorArrowheadPoints(from: PointLike, to: PointLike, size = 10): string {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const bx = to.x - ux * size
  const by = to.y - uy * size
  const px = -uy * size * 0.45
  const py = ux * size * 0.45
  return `${to.x},${to.y} ${bx + px},${by + py} ${bx - px},${by - py}`
}
