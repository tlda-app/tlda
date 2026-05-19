import { StateNode, createShapeId } from 'tldraw'

const REAPER_W = 480
const REAPER_H = 360

export class ReaperTool extends StateNode {
  static override id = 'fleet-reaper'

  override onPointerDown = () => {
    const { editor } = this
    const point = editor.inputs.currentPagePoint
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'fleet-reaper' as any,
      x: point.x - REAPER_W / 2,
      y: point.y - REAPER_H / 2,
      props: { w: REAPER_W, h: REAPER_H },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
