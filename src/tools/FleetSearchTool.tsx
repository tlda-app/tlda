import { StateNode } from 'tldraw'
import { placeFleetShapeAtCursor } from '../shapes/fleet-utils'

const W = 400
const H = 300

export class FleetSearchTool extends StateNode {
  static override id = 'fleet-search'

  override onPointerDown = () => {
    placeFleetShapeAtCursor(this.editor, 'fleet-search', W, H)
  }
}
