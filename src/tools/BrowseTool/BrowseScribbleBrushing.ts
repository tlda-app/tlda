import { SelectTool } from 'tldraw'
import type {
  TLCompleteEventInfo,
  TLKeyboardEventInfo,
  TLPointerEventInfo,
  TLStateNodeConstructor,
} from '@tldraw/editor'
import { pruneBrowseFleetSelection } from './fleetSelectionPolicy'

const ScribbleBrushingBase = getSelectChild('scribble_brushing')

export class BrowseScribbleBrushing extends ScribbleBrushingBase {
  static override id = 'scribble_brushing'

  override onEnter(info: unknown, from: string) {
    super.onEnter?.(info, from)
    pruneBrowseFleetSelection(this.editor)
  }

  override onPointerMove(info: TLPointerEventInfo) {
    super.onPointerMove?.(info)
    pruneBrowseFleetSelection(this.editor)
  }

  override onKeyDown(info: TLKeyboardEventInfo) {
    super.onKeyDown?.(info)
    pruneBrowseFleetSelection(this.editor)
  }

  override onKeyUp(info: TLKeyboardEventInfo) {
    super.onKeyUp?.(info)
    pruneBrowseFleetSelection(this.editor)
  }

  override onComplete(info: TLCompleteEventInfo) {
    super.onComplete?.(info)
    pruneBrowseFleetSelection(this.editor)
  }
}

function getSelectChild(id: string): TLStateNodeConstructor {
  const child = SelectTool.children().find((candidate) => candidate.id === id)
  if (!child) {
    throw new Error(`BrowseScribbleBrushing: ${id} state not found in SelectTool.children()`)
  }
  return child
}
