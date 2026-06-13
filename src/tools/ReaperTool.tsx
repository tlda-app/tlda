import { StateNode } from 'tldraw'
import { placeFleetShapeAtCursor } from '../shapes/fleet-utils'

const REAPER_W = 480
const REAPER_H = 360

export class ReaperTool extends StateNode {
  static override id = 'fleet-reaper'

  override onPointerDown = () => {
    placeFleetShapeAtCursor(this.editor, 'fleet-reaper', REAPER_W, REAPER_H)
  }
}
