import { StateNode, createShapeId } from 'tldraw'
import { getHumanId } from '../fleet/fleet-data.mjs'

const W = 400
const H = 600

export class FleetChatTool extends StateNode {
  static override id = 'fleet-chat'

  override onPointerDown = () => {
    const { editor } = this
    const userId = getHumanId()
    if (!userId) return  // every fleet shape must have a real owner; no anonymous creates
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'fleet-chat' as any,
      x: point.x - W / 2,
      y: point.y,
      props: { w: W, h: H, filter: [], userId },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
