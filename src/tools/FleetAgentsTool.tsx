import { StateNode, createShapeId } from 'tldraw'
import { getHumanId } from '../fleet/fleet-data.mjs'

const W = 400
const H = 500

export class FleetAgentsTool extends StateNode {
  static override id = 'fleet-agents'

  override onPointerDown = () => {
    const { editor } = this
    const userId = getHumanId()
    if (!userId) return
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'fleet-agents' as any,
      x: point.x - W / 2,
      y: point.y,
      props: { w: W, h: H, userId },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
