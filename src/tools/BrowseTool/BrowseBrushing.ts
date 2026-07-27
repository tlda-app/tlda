import { SelectTool } from 'tldraw'
import type {
  TLKeyboardEventInfo,
  TLPointerEventInfo,
  TLShapeId,
  TLStateNodeConstructor,
} from '@tldraw/editor'
import {
  canBrowseSelectFleetShape,
  pruneBrowseFleetSelection,
} from './fleetSelectionPolicy'

const BrushingBase = getSelectChild('brushing')

type BrushStateWithExclusions = {
  excludedShapeIds: Set<TLShapeId>
}

export class BrowseBrushing extends BrushingBase {
  static override id = 'brushing'

  override onEnter(info: TLPointerEventInfo & { target: 'canvas' }, from: string) {
    super.onEnter?.(info, from)
    this.excludeFleetShapesOutsideLayoutMode()
    pruneBrowseFleetSelection(this.editor)
  }

  override onPointerMove(info: TLPointerEventInfo) {
    this.excludeFleetShapesOutsideLayoutMode()
    super.onPointerMove?.(info)
    pruneBrowseFleetSelection(this.editor)
  }

  override onKeyDown(info: TLKeyboardEventInfo) {
    this.excludeFleetShapesOutsideLayoutMode()
    super.onKeyDown?.(info)
    pruneBrowseFleetSelection(this.editor)
  }

  override onKeyUp(info: TLKeyboardEventInfo) {
    this.excludeFleetShapesOutsideLayoutMode()
    super.onKeyUp?.(info)
    pruneBrowseFleetSelection(this.editor)
  }

  private excludeFleetShapesOutsideLayoutMode() {
    const brushState = this as typeof this & BrushStateWithExclusions
    for (const shape of this.editor.getCurrentPageShapes()) {
      if (!canBrowseSelectFleetShape(shape)) brushState.excludedShapeIds.add(shape.id)
    }
  }
}

function getSelectChild(id: string): TLStateNodeConstructor {
  const child = SelectTool.children().find((candidate) => candidate.id === id)
  if (!child) throw new Error(`BrowseBrushing: ${id} state not found in SelectTool.children()`)
  return child
}
