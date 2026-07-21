import { markFleetPillInactive } from './fleet-pill-transient'

export type FleetPillSnapState = {
  deltaX: number
  deltaY: number
  lines: Array<{ axis: 'x' | 'y'; pos: number }>
  active: boolean
  expanded: boolean
  prevSnapMode: boolean | undefined
}

type FleetPillLifecycleEditor = {
  getShape: (id: any) => unknown
  deleteShapes: (ids: any[]) => void
  user: {
    updateUserPreferences: (preferences: { isSnapMode: boolean }) => void
  }
}

export function finishFleetPillTranslation(
  editor: FleetPillLifecycleEditor,
  pillId: any,
  snapState: FleetPillSnapState,
  options: { deferDelete?: boolean } = {},
) {
  if (snapState.prevSnapMode !== undefined) {
    editor.user.updateUserPreferences({ isSnapMode: snapState.prevSnapMode })
  }
  snapState.active = false
  snapState.expanded = false
  snapState.prevSnapMode = undefined
  snapState.deltaX = 0
  snapState.deltaY = 0
  snapState.lines = []

  const deleteIfPresent = () => {
    markFleetPillInactive(String(pillId))
    if (editor.getShape(pillId)) editor.deleteShapes([pillId])
  }
  if (options.deferDelete) queueMicrotask(deleteIfPresent)
  else deleteIfPresent()
}

export function cancelDragBeforeRelease(cancelDrag: () => void, release: () => void) {
  cancelDrag()
  release()
}
