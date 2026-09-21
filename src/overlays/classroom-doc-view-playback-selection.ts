import { shouldRenderLockedFleetViewportShape } from './fleet-viewport-predicate.ts'

export function classroomDocViewPlaybackSelection(
  shapes: readonly any[],
  owner: { userId: string; deviceId: string },
  deviceReady = true,
): any[] {
  if (!deviceReady) return []
  const owned = shapes.filter(shape => (
    shape.type === 'fleet-docview' &&
    shouldRenderLockedFleetViewportShape(shape, owner)
  ))
  const local = owned.find(shape => String(shape.id).endsWith('-app-local'))
  return local ? [local] : owned
}
