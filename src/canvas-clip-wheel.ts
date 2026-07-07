import type { ClipBounds } from './CanvasClipPanel'

export function isCanvasClipWheelMessage(
  data: unknown,
  viewportId: string,
  requestedShapeIds: Set<string>,
) {
  if (!data || typeof data !== 'object') return false
  const message = data as { type?: unknown; viewportId?: unknown; shapeId?: unknown }
  return message.type === 'tlda-clip-wheel' &&
    message.viewportId === viewportId &&
    typeof message.shapeId === 'string' &&
    requestedShapeIds.has(message.shapeId)
}

export function canvasClipWheelCamera(
  camera: { x: number; y: number; z: number },
  deltaX: number,
  deltaY: number,
  bounds: ClipBounds | null,
  panelWidth: number,
  canvasHeight: number,
  options: { zoom?: boolean } = {},
) {
  const z = camera.z || 1
  if (options.zoom) {
    const nextZ = Math.max(0.05, Math.min(8, z * Math.exp(-deltaY * 0.002)))
    const visibleW = panelWidth / z
    const visibleH = canvasHeight / z
    const centerX = -camera.x + visibleW / 2
    const centerY = -camera.y + visibleH / 2
    const nextVisibleW = panelWidth / nextZ
    const nextVisibleH = canvasHeight / nextZ
    const next = {
      ...camera,
      z: nextZ,
      x: -(centerX - nextVisibleW / 2) - deltaX / nextZ,
      y: -(centerY - nextVisibleH / 2),
    }
    return clampClipCamera(next, bounds, panelWidth, canvasHeight)
  }
  return clampClipCamera({
    ...camera,
    x: camera.x - deltaX / z,
    y: camera.y - deltaY / z,
  }, bounds, panelWidth, canvasHeight)
}

function clampClipCamera(
  camera: { x: number; y: number; z: number },
  bounds: ClipBounds | null,
  panelWidth: number,
  canvasHeight: number,
) {
  const cleanZero = (value: number) => Object.is(value, -0) ? 0 : value
  const z = camera.z || 1
  const visibleW = panelWidth / z
  const visibleH = canvasHeight / z
  if (!bounds) return camera
  const maxX = -bounds.x
  const minX = -(bounds.x + Math.max(0, bounds.w - visibleW))
  const maxY = -bounds.y
  const minY = -(bounds.y + Math.max(0, bounds.h - visibleH))
  return {
    ...camera,
    x: cleanZero(Math.min(maxX, Math.max(minX, camera.x))),
    y: cleanZero(Math.min(maxY, Math.max(minY, camera.y))),
  }
}
