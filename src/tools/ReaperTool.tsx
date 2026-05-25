import { StateNode, createShapeId } from 'tldraw'

const REAPER_W = 480
const REAPER_H = 360

export class ReaperTool extends StateNode {
  static override id = 'fleet-reaper'

  override onPointerDown = () => {
    const { editor } = this
    const hudEditor = (window as any).__tldraw_hud_editor__
    const screen = editor.inputs.currentScreenPoint

    let x: number, y: number
    if (hudEditor) {
      const cam = hudEditor.getCamera()
      x = (screen.x / cam.z) - cam.x - REAPER_W / 2
      y = (screen.y / cam.z) - cam.y - REAPER_H / 2
    } else {
      const point = editor.inputs.currentPagePoint
      x = point.x - REAPER_W / 2
      y = point.y - REAPER_H / 2
    }

    const id = createShapeId()
    editor.createShape({
      id,
      type: 'fleet-reaper' as any,
      x,
      y,
      props: { w: REAPER_W, h: REAPER_H },
    })
    editor.setCurrentTool('select')
    editor.select(id)
  }
}
