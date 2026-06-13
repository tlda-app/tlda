import { StateNode } from 'tldraw'
import { createFleetShape } from '../shapes/fleet-utils'

const W = 360
const H = 560

export class FleetInboxTool extends StateNode {
  static override id = 'fleet-inbox'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createFleetShape(editor, 'fleet-inbox', point.x - W / 2, point.y, { w: W, h: H })
    if (!id) return
    editor.setCurrentTool('select')
    editor.select(id as any)
  }
}
