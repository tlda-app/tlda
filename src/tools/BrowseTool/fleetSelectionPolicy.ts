import type { Editor, TLShape } from '@tldraw/editor'
import { fleetLayoutActiveRef } from '../../overlays/fleet-layout-mode'
import { FLEET_SHAPE_TYPES } from '../../shapes/fleet-utils'

export function isFleetShape(shape: TLShape | null | undefined): boolean {
  return !!shape && FLEET_SHAPE_TYPES.has(shape.type as string)
}

export function canBrowseSelectFleetShape(shape: TLShape): boolean {
  return !isFleetShape(shape) || fleetLayoutActiveRef.current
}

export function pruneBrowseFleetSelection(editor: Editor) {
  const selected = editor.getSelectedShapeIds()
  const next = selected.filter((id) => {
    const shape = editor.getShape(id)
    return !shape || canBrowseSelectFleetShape(shape)
  })
  if (next.length !== selected.length) editor.setSelectedShapes(next)
}
