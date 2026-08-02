import { noteFleetPillDeleted } from './fleet-pill-forensics'
import { markFleetPillInactive } from './fleet-pill-transient'

export type FleetPillSnapState = {
  deltaX: number
  deltaY: number
  lines: Array<{ axis: 'x' | 'y'; pos: number }>
  active: boolean
  expanded: boolean
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
  snapState.active = false
  snapState.expanded = false
  snapState.deltaX = 0
  snapState.deltaY = 0
  snapState.lines = []

  const deleteIfPresent = () => {
    if (editor.getShape(pillId)) noteFleetPillDeleted(String(pillId), 'translate-end')
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
