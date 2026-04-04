import { StateNode, createShapeId } from 'tldraw'

const W = 400
const H = 600

export class FleetChatTool extends StateNode {
  static override id = 'fleet-chat'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'fleet-chat',
      x: point.x - W / 2,
      y: point.y,
      props: { w: W, h: H, filter: [] },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
