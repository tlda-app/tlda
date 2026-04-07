import { StateNode, createShapeId } from 'tldraw'

const W = 480
const H = 520

export class TaskInboxTool extends StateNode {
  static override id = 'task-inbox'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'task-inbox' as any,
      x: point.x - W / 2,
      y: point.y,
      props: { w: W, h: H },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
