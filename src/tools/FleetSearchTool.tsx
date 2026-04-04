import { StateNode, createShapeId } from 'tldraw'

const W = 400
const H = 300

export class FleetSearchTool extends StateNode {
  static override id = 'fleet-search'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'fleet-search',
      x: point.x - W / 2,
      y: point.y,
      props: { w: W, h: H },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
