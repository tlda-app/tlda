import { StateNode } from 'tldraw'
import { placeFleetShapeAtCursor, FLEET_TOOL_DIMS } from '../shapes/fleet-utils'

const { w: W, h: H } = FLEET_TOOL_DIMS['fleet-inbox']

export class FleetInboxTool extends StateNode {
  static override id = 'fleet-inbox'

  override onPointerDown = () => {
    placeFleetShapeAtCursor(this.editor, 'fleet-inbox', W, H)
  }
}
