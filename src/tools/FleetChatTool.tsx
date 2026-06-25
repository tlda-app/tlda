import { StateNode } from 'tldraw'
import { placeFleetShapeAtCursor, FLEET_TOOL_DIMS } from '../shapes/fleet-utils'

const { w: W, h: H } = FLEET_TOOL_DIMS['fleet-chat']

export class FleetChatTool extends StateNode {
  static override id = 'fleet-chat'

  override onPointerDown = () => {
    placeFleetShapeAtCursor(this.editor, 'fleet-chat', W, H, { filter: [] })
  }
}
