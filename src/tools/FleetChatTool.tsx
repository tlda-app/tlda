import { StateNode } from 'tldraw'
import { createFleetShape } from '../shapes/fleet-utils'

const W = 400
const H = 600

export class FleetChatTool extends StateNode {
  static override id = 'fleet-chat'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createFleetShape(editor, 'fleet-chat', point.x - W / 2, point.y, { w: W, h: H, filter: [] })
    if (!id) return
    editor.setCurrentTool('select')
    editor.select(id as any)
  }
}
