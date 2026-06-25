import { StateNode } from 'tldraw'
import { placeFleetShapeAtCursor, FLEET_TOOL_DIMS } from '../shapes/fleet-utils'

const { w: W, h: H } = FLEET_TOOL_DIMS['fleet-search']

export class FleetSearchTool extends StateNode {
  static override id = 'fleet-search'

  override onPointerDown = () => {
    placeFleetShapeAtCursor(this.editor, 'fleet-search', W, H)
  }
}
