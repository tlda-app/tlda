import { StateNode } from 'tldraw'
import { createFleetShape } from '../shapes/fleet-utils'

const W = 400
const H = 500

export class FleetAgentsTool extends StateNode {
  static override id = 'fleet-agents'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createFleetShape(editor, 'fleet-agents', point.x - W / 2, point.y, { w: W, h: H })
    if (!id) return
    editor.setCurrentTool('select')
    editor.select(id as any)
  }
}
