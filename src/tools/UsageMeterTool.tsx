import { StateNode, createShapeId } from 'tldraw'

const USAGE_W = 280
const USAGE_H = 200

export class UsageMeterTool extends StateNode {
  static override id = 'usage-meter'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'usage-meter' as any,
      x: point.x - USAGE_W / 2,
      y: point.y - USAGE_H / 2,
      props: { w: USAGE_W, h: USAGE_H },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
