import { StateNode } from 'tldraw'
import { placeFleetShapeAtCursor, FLEET_TOOL_DIMS } from '../shapes/fleet-utils'

const { w: W, h: H } = FLEET_TOOL_DIMS['fleet-agents']

export class FleetAgentsTool extends StateNode {
  static override id = 'fleet-agents'

  override onPointerDown = () => {
    placeFleetShapeAtCursor(this.editor, 'fleet-agents', W, H)
  }
}
