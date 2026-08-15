import type { ClipBounds } from './CanvasClipPanel'

export type CanvasClipCamera = { x: number; y: number; z: number }

type CanvasClipCameraOptions = {
  panSpeed?: number
  zoomSpeed?: number
  zoomSteps?: number[]
}

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
  camera: CanvasClipCamera,
  deltaX: number,
  deltaY: number,
  bounds: ClipBounds | null,
  panelWidth: number,
  canvasHeight: number,
  options: {
    zoom?: boolean
    unboundedPan?: boolean
    cameraOptions?: CanvasClipCameraOptions
    screenPoint?: { x: number; y: number }
  } = {},
) {
  const z = camera.z || 1
  const panSpeed = options.cameraOptions?.panSpeed ?? 1
  const zoomSpeed = options.cameraOptions?.zoomSpeed ?? 1
  if (options.zoom) {
    const zoomSteps = options.cameraOptions?.zoomSteps
    const minZoom = zoomSteps?.[0] ?? 0.05
    const maxZoom = zoomSteps?.[zoomSteps.length - 1] ?? 8
    const cappedDelta = Math.abs(deltaY) > 10 ? 10 * Math.sign(deltaY) : deltaY
    const nextZ = Math.max(minZoom, Math.min(maxZoom, z - (cappedDelta / 100) * zoomSpeed * z))
    const screenPoint = options.screenPoint ?? { x: panelWidth / 2, y: canvasHeight / 2 }
    const pagePoint = {
      x: screenPoint.x / z - camera.x,
      y: screenPoint.y / z - camera.y,
    }
    const next = {
      ...camera,
      z: nextZ,
      x: screenPoint.x / nextZ - pagePoint.x - (deltaX * panSpeed) / nextZ,
      y: screenPoint.y / nextZ - pagePoint.y,
    }
    return clampClipCamera(next, bounds, panelWidth, canvasHeight)
  }
  return canvasClipPanCamera(camera, deltaX, deltaY, bounds, panelWidth, canvasHeight, options)
}

export function canvasClipPanCamera(
  camera: CanvasClipCamera,
  deltaX: number,
  deltaY: number,
  bounds: ClipBounds | null,
  panelWidth: number,
  canvasHeight: number,
  options: { unboundedPan?: boolean; cameraOptions?: CanvasClipCameraOptions } = {},
) {
  const z = camera.z || 1
  const panSpeed = options.cameraOptions?.panSpeed ?? 1
  const next = {
    ...camera,
    x: camera.x - (deltaX * panSpeed) / z,
    y: camera.y - (deltaY * panSpeed) / z,
  }
  return options.unboundedPan ? next : clampClipCamera(next, bounds, panelWidth, canvasHeight)
}

function clampClipCamera(
  camera: CanvasClipCamera,
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
