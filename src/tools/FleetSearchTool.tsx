import { StateNode, createShapeId } from 'tldraw'
import { getHumanId } from '../fleet/fleet-data.mjs'

const W = 400
const H = 300

export class FleetSearchTool extends StateNode {
  static override id = 'fleet-search'

  override onPointerDown = () => {
    const { editor } = this
    const userId = getHumanId()
    if (!userId) return
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'fleet-search' as any,
      x: point.x - W / 2,
      y: point.y,
      props: { w: W, h: H, userId },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
