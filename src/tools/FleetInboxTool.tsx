import { StateNode } from 'tldraw'
import { placeFleetShapeAtCursor } from '../shapes/fleet-utils'

const W = 360
const H = 560

export class FleetInboxTool extends StateNode {
  static override id = 'fleet-inbox'

  override onPointerDown = () => {
    placeFleetShapeAtCursor(this.editor, 'fleet-inbox', W, H)
  }
}
