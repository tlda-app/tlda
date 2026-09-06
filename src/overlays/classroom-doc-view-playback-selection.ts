import { shouldRenderLockedFleetViewportShape } from './fleet-viewport-predicate.ts'

export function classroomDocViewPlaybackSelection(
  shapes: readonly any[],
  owner: { userId: string; deviceId: string },
  deviceReady = true,
): any[] {
  if (!deviceReady) return []
  return shapes.filter(shape => (
    shape.type === 'fleet-docview' &&
    shouldRenderLockedFleetViewportShape(shape, owner)
  ))
}
