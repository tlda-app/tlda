import { StateNode } from 'tldraw'
import { placeFleetShapeAtCursor, FLEET_TOOL_DIMS } from '../shapes/fleet-utils'

const { w: W, h: H } = FLEET_TOOL_DIMS['fleet-reaper']

export class ReaperTool extends StateNode {
  static override id = 'fleet-reaper'

  override onPointerDown = () => {
    placeFleetShapeAtCursor(this.editor, 'fleet-reaper', W, H)
  }
}
