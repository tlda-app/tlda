import { StateNode, createShapeId } from 'tldraw'

const REAPER_W = 480
const REAPER_H = 360
const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview', 'fleet-reaper'])
const GAP = 10

export class ReaperTool extends StateNode {
  static override id = 'fleet-reaper'

  override onPointerDown = () => {
    const { editor } = this

    const fleetShapes = editor.getCurrentPageShapes()
      .filter(s => FLEET_TYPES.has(s.type as string))
    let x: number, y: number
    if (fleetShapes.length > 0) {
      let minX = Infinity, maxY = -Infinity
      for (const s of fleetShapes) {
        const b = editor.getShapePageBounds(s.id)
        if (!b) continue
        minX = Math.min(minX, b.minX)
        maxY = Math.max(maxY, b.maxY)
      }
      x = minX
      y = maxY + GAP
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
