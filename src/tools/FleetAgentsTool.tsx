import { StateNode, createShapeId } from 'tldraw'

const W = 400
const H = 500

export class FleetAgentsTool extends StateNode {
  static override id = 'fleet-agents'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'fleet-agents' as any,
      x: point.x - W / 2,
      y: point.y,
      props: { w: W, h: H },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
