import { StateNode, createShapeId } from 'tldraw'

const W = 560
const H = 380

export class TerminalTool extends StateNode {
  static override id = 'terminal'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'terminal' as any,
      x: point.x - W / 2,
      y: point.y,
      props: { w: W, h: H, agentId: '' },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
